package fr.karafun.plus.solver;

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
import java.util.concurrent.ConcurrentHashMap;

/** Long-lived local JSON-lines worker. It never opens a network port. */
public final class Main {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int DEFAULT_BUDGET_MS = 3_000;
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

    private static Map<String, Object> solve(JsonNode input) {
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
        Map<String, Integer> pastAppearance = integers(input.path("pastAppearance"));
        Map<String, Integer> physicalCount = integers(input.path("physicalCount"));
        List<String> lastGroups = strings(input.path("lastGroups"));
        QueueLine line = new QueueLine(FairSeed.build(performances, pinned,
                physicalCount, pastAppearance, lastGroups), pinned);
        QueuePlan plan = new QueuePlan(performances, line,
                pastAppearance, physicalCount,
                lastGroups, new HashSet<>(strings(input.path("roundPeople"))),
                new HashSet<>(strings(input.path("roundGroups"))),
                integers(input.path("tableServeCounts")), integers(input.path("groupReadyCounts")),
                input.path("tableRotation").asBoolean(false),
                input.path("weightedTables").asBoolean(false));
        Solver<QueuePlan> solver = factoryFor(budgetMs).buildSolver();
        QueuePlan solution = solver.solve(plan);
        if (solution.getScore() == null || solution.getScore().hardScore() < 0) {
            throw new IllegalStateException("Aucun ordre admissible");
        }
        List<String> order = solution.getLines().get(0).getPerformances().stream()
                .map(Performance::getId).toList();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("requestId", requestId);
        response.put("order", order);
        response.put("score", solution.getScore().toString());
        response.put("elapsedMs", (System.nanoTime() - start) / 1_000_000);
        return response;
    }

    public static void main(String[] args) throws Exception {
        try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
                PrintWriter output = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true)) {
            for (String line; (line = input.readLine()) != null;) {
                String requestId = "";
                try {
                    if (line.length() > 512_000) throw new IllegalArgumentException("Requête trop grande");
                    JsonNode request = JSON.readTree(line);
                    requestId = request.path("requestId").asText("");
                    output.println(JSON.writeValueAsString(solve(request)));
                } catch (Exception error) {
                    Map<String, Object> failed = Map.of("requestId", requestId,
                            "error", error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
                    output.println(JSON.writeValueAsString(failed));
                    System.err.println("Timefold: " + error);
                }
                output.flush();
            }
        }
    }
}
