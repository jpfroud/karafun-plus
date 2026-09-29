package fr.karafun.plus.solver;

import ai.timefold.solver.core.api.score.HardMediumSoftScore;
import ai.timefold.solver.core.api.solver.SolutionManager;
import ai.timefold.solver.core.api.solver.Solver;
import ai.timefold.solver.core.api.solver.SolverFactory;
import ai.timefold.solver.core.config.solver.SolverConfig;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Long-lived local JSON-lines worker. It never opens a network port. A newer
 * request interrupts the running search (terminateEarly) instead of forcing
 * Node to restart the JVM, so the solver stays warm during the evening.
 */
public final class Main {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int DEFAULT_BUDGET_MS = 3_000;
    private static final String EOF = new String("EOF");
    private static final Map<Integer, SolverFactory<QueuePlan>> FACTORIES = new ConcurrentHashMap<>();

    private static SolverFactory<QueuePlan> factoryFor(int budgetMs) {
        return FACTORIES.computeIfAbsent(budgetMs, duration -> {
            SolverConfig config = SolverConfig.createFromXmlResource("solverConfig.xml");
            config.getTerminationConfig().setMillisecondsSpentLimit((long) duration);
            return SolverFactory.create(config);
        });
    }

    private Main() { }

    private static List<String> strings(JsonNode node) {
        List<String> values = new ArrayList<>();
        if (node == null || !node.isArray()) return values;
        for (JsonNode item : node) if (item.isTextual()) values.add(item.asText());
        return values;
    }

    private static Map<String, Integer> integers(JsonNode node) {
        Map<String, Integer> values = new HashMap<>();
        if (node == null || !node.isObject()) return values;
        node.properties().forEach(entry -> {
            if (entry.getValue().canConvertToInt()) {
                values.put(entry.getKey(), entry.getValue().asInt());
            }
        });
        return values;
    }

    private static Map<String, Double> doubles(JsonNode node, double min, double max) {
        Map<String, Double> values = new HashMap<>();
        if (node == null || !node.isObject()) return values;
        node.properties().forEach(entry -> {
            if (entry.getValue().isNumber()) {
                double value = entry.getValue().asDouble();
                if (value < min || value > max) throw new IllegalArgumentException("Pondération invalide");
                values.put(entry.getKey(), value);
            }
        });
        return values;
    }

    private static List<List<String>> history(JsonNode node) {
        List<List<String>> values = new ArrayList<>();
        if (node == null || !node.isArray()) return values;
        for (JsonNode item : node) {
            List<String> groups = strings(item);
            if (!groups.isEmpty()) values.add(groups);
        }
        return values.subList(Math.max(0, values.size() - 200), values.size());
    }

    private static QueuePlan.Rotation rotation(JsonNode input) {
        String value = input.path("rotation").asText("");
        if (value.isEmpty()) {
            // Anciennes requêtes : deux booléens.
            if (!input.path("tableRotation").asBoolean(false)) return QueuePlan.Rotation.PEOPLE;
            return input.path("weightedTables").asBoolean(false) ? QueuePlan.Rotation.SQRT : QueuePlan.Rotation.EQUAL;
        }
        return switch (value) {
            case "people" -> QueuePlan.Rotation.PEOPLE;
            case "equal" -> QueuePlan.Rotation.EQUAL;
            case "sqrt" -> QueuePlan.Rotation.SQRT;
            default -> throw new IllegalArgumentException("Mode de rotation inconnu");
        };
    }

    private static Map<String, Object> solve(JsonNode input, AtomicReference<Solver<QueuePlan>> active) {
        long start = System.nanoTime();
        int budgetMs = input.path("budgetMs").asInt(DEFAULT_BUDGET_MS);
        if (budgetMs < 100 || budgetMs > 30_000) {
            throw new IllegalArgumentException("Budget Timefold invalide");
        }
        String requestId = input.path("requestId").asText("");
        List<Performance> performances = new ArrayList<>();
        Set<String> songIds = new HashSet<>();
        JsonNode rows = input.path("performances");
        if (!rows.isArray() || rows.size() > 200) throw new IllegalArgumentException("1 à 200 chansons requises");
        for (JsonNode row : rows) {
            String id = row.path("id").asText("");
            String owner = row.path("owner").asText("");
            List<String> singers = strings(row.path("singers"));
            List<String> groups = strings(row.path("groups"));
            if (id.isEmpty() || owner.isEmpty() || !songIds.add(id) || singers.isEmpty() ||
                    singers.size() > 2 || groups.isEmpty()) {
                throw new IllegalArgumentException("Chanson ou duo invalide");
            }
            performances.add(new Performance(id, owner, row.path("ownerSongIndex").asInt(0),
                    singers, groups, row.path("previousIndex").asInt(0)));
        }
        int pinned = input.path("pinnedUntil").asInt(0);
        if (pinned < 0 || pinned > performances.size()) throw new IllegalArgumentException("Préfixe figé invalide");
        // L'ordre reçu est celui que Node applique déjà : Timefold part de là
        // et ne propose un changement que s'il améliore le score.
        QueueLine line = new QueueLine(performances, pinned);
        QueuePlan plan = new QueuePlan(performances, line,
                integers(input.path("pastAppearance")), integers(input.path("physicalCount")),
                integers(input.path("readyAt")), strings(input.path("lastGroups")),
                new HashSet<>(strings(input.path("roundPeople"))),
                doubles(input.path("roundUse"), 0, 10), doubles(input.path("personWeights"), 0.1, 10),
                doubles(input.path("tableWeights"), 0.1, 10), history(input.path("history")),
                rotation(input), input.path("interleaveArrivals").asBoolean(true));
        SolverFactory<QueuePlan> factory = factoryFor(budgetMs);
        SolutionManager<QueuePlan, HardMediumSoftScore> manager = SolutionManager.create(factory);
        HardMediumSoftScore seedScore = manager.update(plan);
        if (seedScore.hardScore() < 0) {
            // Ordre reçu inadmissible (appel direct, ancien client) : repartir
            // d'un ordre qui respecte déjà listes personnelles et premiers passages.
            line.setPerformances(new ArrayList<>(FairSeed.build(performances, pinned,
                    plan.getPhysicalCount(), plan.getPastAppearance(), plan.getLastGroups())));
            seedScore = manager.update(plan);
        }
        Solver<QueuePlan> solver = factory.buildSolver();
        active.set(solver);
        QueuePlan solution;
        try {
            solution = solver.solve(plan);
        } finally {
            active.set(null);
        }
        if (solution.getScore() == null || solution.getScore().hardScore() < 0 &&
                solution.getScore().compareTo(seedScore) <= 0) {
            throw new IllegalStateException("Aucun ordre admissible");
        }
        List<String> order = solution.getLines().get(0).getPerformances().stream()
                .map(Performance::getId).toList();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("requestId", requestId);
        response.put("order", order);
        response.put("score", solution.getScore().toString());
        response.put("seedScore", seedScore == null ? null : seedScore.toString());
        response.put("improved", seedScore != null && solution.getScore().compareTo(seedScore) > 0);
        response.put("elapsedMs", (System.nanoTime() - start) / 1_000_000);
        return response;
    }

    public static void main(String[] args) throws Exception {
        BlockingQueue<String> inbox = new LinkedBlockingQueue<>();
        AtomicReference<Solver<QueuePlan>> active = new AtomicReference<>();
        Thread reader = new Thread(() -> {
            try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
                for (String line; (line = input.readLine()) != null;) {
                    inbox.put(line);
                    // Un état plus récent de la file rend la recherche en cours inutile.
                    Solver<QueuePlan> running = active.get();
                    if (running != null) running.terminateEarly();
                }
            } catch (Exception error) {
                System.err.println("Timefold: lecture interrompue " + error);
            } finally {
                inbox.offer(EOF);
            }
        }, "karafun-solver-input");
        reader.setDaemon(true);
        reader.start();
        try (PrintWriter output = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true)) {
            while (true) {
                String line = inbox.take();
                if (line == EOF) break;
                boolean closing = false;
                for (String newer; (newer = inbox.poll()) != null;) {
                    if (newer == EOF) { closing = true; break; }
                    line = newer; // seule la demande la plus récente compte
                }
                String requestId = "";
                try {
                    if (line.length() > 512_000) throw new IllegalArgumentException("Requête trop grande");
                    JsonNode request = JSON.readTree(line);
                    requestId = request.path("requestId").asText("");
                    output.println(JSON.writeValueAsString(solve(request, active)));
                } catch (Exception error) {
                    Map<String, Object> failed = Map.of("requestId", requestId,
                            "error", error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
                    output.println(JSON.writeValueAsString(failed));
                    System.err.println("Timefold: " + error);
                }
                output.flush();
                if (closing) break;
            }
        }
    }
}
