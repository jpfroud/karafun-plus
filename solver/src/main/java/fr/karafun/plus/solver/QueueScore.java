package fr.karafun.plus.solver;

import ai.timefold.solver.core.api.score.HardMediumSoftScore;
import ai.timefold.solver.core.api.score.calculator.EasyScoreCalculator;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Same bar policy as scheduler.js#_pick, evaluated on a whole planned queue.
 * Hard: the singer's own playlist order, and first appearances of the evening
 * before anyone's return. Medium: once per round (with bonus/malus credits),
 * no table twice in a row when another can sing, spacing of a returning
 * person, and each table's share of the round. Soft: stability versus the
 * order proposed by the Node process.
 */
public class QueueScore implements EasyScoreCalculator<QueuePlan, HardMediumSoftScore> {
    private static final double EPS = 1e-9;
    private static final int UNKNOWN = -1000;

    @Override
    public HardMediumSoftScore calculateScore(QueuePlan plan) {
        if (plan.getLines() == null || plan.getLines().isEmpty()) {
            return HardMediumSoftScore.ZERO;
        }
        QueueLine line = plan.getLines().get(0);
        List<Performance> order = line.getPerformances();
        int n = order.size();
        long hard = 0, medium = 0, soft = 0;
        Map<String, Integer> lastSongOfOwner = new HashMap<>();
        Map<String, Integer> lastSeen = new HashMap<>(plan.getPastAppearance());
        Map<String, Integer> appeared = new HashMap<>(plan.getPhysicalCount());
        Set<String> round = new HashSet<>(plan.getRoundPeople());
        Map<String, Double> roundUse = new HashMap<>(plan.getRoundUse());
        List<List<String>> history = new ArrayList<>(plan.getHistory());
        List<String> previous = plan.getLastGroups();

        for (int pos = 0; pos < n; pos++) {
            Performance current = order.get(pos);
            final List<String> prior = previous;
            Integer priorSong = lastSongOfOwner.put(current.getOwner(), current.getOwnerSongIndex());
            if (priorSong != null && priorSong >= current.getOwnerSongIndex()) hard -= 1;
            boolean pinned = pos < line.getPinnedUntil();

            // What the bar could send at this point: each owner's next title.
            List<Performance> candidates = new ArrayList<>();
            Set<String> owners = new HashSet<>();
            for (int j = pos; j < n; j++) {
                Performance candidate = order.get(j);
                if (owners.add(candidate.getOwner())) candidates.add(candidate);
            }
            if (candidates.stream().allMatch(c -> allIn(c, round))) {
                int resets = 0;
                do { resetRound(round, roundUse); resets++; }
                while (resets < 4 && candidates.stream().allMatch(c -> allIn(c, round)));
            }

            // First appearances of the evening.
            List<Performance> tier = new ArrayList<>();
            for (Performance c : candidates) if (freshCount(c, appeared) == c.getSingers().size()) tier.add(c);
            if (tier.isEmpty()) {
                int least = Integer.MAX_VALUE;
                for (Performance c : candidates) {
                    if (freshCount(c, appeared) > 0) least = Math.min(least, totalAppearances(c, appeared));
                }
                for (Performance c : candidates) {
                    if (freshCount(c, appeared) > 0 && totalAppearances(c, appeared) == least) tier.add(c);
                }
                if (tier.isEmpty()) tier.addAll(candidates);
            }
            // Once per round.
            List<Performance> choices = new ArrayList<>();
            for (Performance c : tier) if (noneIn(c, round)) choices.add(c);
            if (choices.isEmpty()) {
                int fewest = Integer.MAX_VALUE;
                for (Performance c : tier) if (!allIn(c, round)) fewest = Math.min(fewest, repeats(c, round));
                for (Performance c : tier) if (!allIn(c, round) && repeats(c, round) == fewest) choices.add(c);
                if (choices.isEmpty()) choices.addAll(tier);
            }
            // A table that arrives at once is interleaved with people who
            // have not sung since any waiting person started waiting.
            boolean streak = plan.isInterleaveArrivals() && !prior.isEmpty() &&
                    choices.stream().allMatch(c -> overlaps(c.getGroups(), prior));
            List<Performance> alternates = new ArrayList<>();
            if (streak) {
                for (Performance c : candidates) {
                    if (choices.contains(c) || overlaps(c.getGroups(), prior)) continue;
                    boolean allowed = true;
                    for (String singer : c.getSingers()) {
                        int seen = lastSeen.getOrDefault(singer, UNKNOWN);
                        if (appeared.getOrDefault(singer, 0) == 0 || seen <= UNKNOWN) { allowed = false; break; }
                        for (Performance other : candidates) {
                            String owner = other.getOwner();
                            if (c.getSingers().contains(owner)) continue;
                            int waitStart = Math.max(lastSeen.getOrDefault(owner, UNKNOWN),
                                    plan.getReadyAt().getOrDefault(owner, UNKNOWN));
                            if (seen > waitStart) { allowed = false; break; }
                        }
                        if (!allowed) break;
                    }
                    if (allowed) alternates.add(c);
                }
            }
            List<Performance> allowedNow = alternates.isEmpty() ? choices : alternates;
            if (!pinned && !allowedNow.contains(current)) {
                if (!tier.contains(current)) hard -= 1;
                else if (!choices.contains(current)) medium -= 5_000;
                // Otherwise only the streak was avoidable: counted below.
            }

            boolean overlapsPrevious = !prior.isEmpty() && overlaps(current.getGroups(), prior);
            if (overlapsPrevious && candidates.stream().anyMatch(c -> !overlaps(c.getGroups(), prior))) {
                medium -= 1_500;
            }

            // A person who just sang lets others go first when possible.
            for (String singer : current.getSingers()) {
                Integer last = lastSeen.get(singer);
                if (last != null && last > UNKNOWN) {
                    int deficit = Math.max(0, 4 - (pos - last));
                    medium -= (long) deficit * deficit * 180;
                } else if (appeared.getOrDefault(singer, 0) == 0 && pos > 0) {
                    medium -= pos * 8L;
                }
            }

            // Each table's share of the round, as in scheduler.js.
            Map<String, Double> weights = groupWeights(candidates, plan);
            double total = weights.values().stream().mapToDouble(Double::doubleValue).sum();
            int window = Math.max(4, owners.size());
            List<List<String>> recent = history.subList(Math.max(0, history.size() - window), history.size());
            Map<String, Double> deficits = new HashMap<>();
            for (Map.Entry<String, Double> entry : weights.entrySet()) {
                long served = recent.stream().filter(groups -> groups.contains(entry.getKey())).count();
                deficits.put(entry.getKey(), total > EPS ?
                        (recent.size() + 1) * entry.getValue() / total - served : -served);
            }
            double best = Double.NEGATIVE_INFINITY;
            for (Performance c : allowedNow) best = Math.max(best, need(c, deficits));
            double chosen = need(current, deficits);
            if (best > chosen + EPS && best != Double.NEGATIVE_INFINITY) {
                medium -= Math.round((best - chosen) * 150);
            }

            for (String singer : current.getSingers()) {
                lastSeen.put(singer, pos);
                appeared.merge(singer, 1, Integer::sum);
                useRound(round, roundUse, singer, weight(plan, singer));
            }
            history.add(current.getGroups());
            previous = current.getGroups();

            int displacement = Math.abs(pos - current.getPreviousIndex());
            soft -= (long) displacement * (current.getPreviousIndex() < 5 ? 10 : 3);
        }
        return HardMediumSoftScore.of(hard, medium, soft);
    }

    private static double weight(QueuePlan plan, String person) {
        return plan.getPersonWeights().getOrDefault(person, 1.0);
    }

    private static Map<String, Double> groupWeights(List<Performance> candidates, QueuePlan plan) {
        Map<String, Set<String>> members = new HashMap<>();
        for (Performance c : candidates) {
            String ownerGroup = c.getGroups().get(0);
            members.computeIfAbsent(ownerGroup, g -> new HashSet<>()).add(c.getOwner());
        }
        for (Performance c : candidates) for (String g : c.getGroups()) members.computeIfAbsent(g, x -> new HashSet<>());
        Map<String, Double> out = new HashMap<>();
        for (Map.Entry<String, Set<String>> entry : members.entrySet()) {
            double sum = 0;
            for (String person : entry.getValue()) sum += weight(plan, person);
            double value = entry.getValue().isEmpty() ? 0 : switch (plan.getRotation()) {
                case PEOPLE -> sum;
                case SQRT -> Math.sqrt(sum);
                case EQUAL -> plan.getTableWeights().getOrDefault(entry.getKey(), 1.0);
            };
            out.put(entry.getKey(), value);
        }
        return out;
    }

    private static double need(Performance c, Map<String, Double> deficits) {
        double best = Double.NEGATIVE_INFINITY;
        for (String g : c.getGroups()) best = Math.max(best, deficits.getOrDefault(g, Double.NEGATIVE_INFINITY));
        return best;
    }

    private static void useRound(Set<String> round, Map<String, Double> use, String person, double weight) {
        double cost = 1 / weight;
        if (Math.abs(cost - 1) < EPS && !use.containsKey(person)) { round.add(person); return; }
        double used = use.getOrDefault(person, 0.0) + cost;
        use.put(person, used);
        if (used >= 1 - EPS) round.add(person);
    }

    private static void resetRound(Set<String> round, Map<String, Double> use) {
        round.clear();
        for (Map.Entry<String, Double> entry : new ArrayList<>(use.entrySet())) {
            double left = entry.getValue() - 1;
            if (left <= EPS) use.remove(entry.getKey());
            else {
                use.put(entry.getKey(), left);
                if (left >= 1 - EPS) round.add(entry.getKey());
            }
        }
    }

    private static boolean overlaps(List<String> a, List<String> b) {
        for (String x : a) if (b.contains(x)) return true;
        return false;
    }

    private static boolean allIn(Performance c, Set<String> round) {
        for (String singer : c.getSingers()) if (!round.contains(singer)) return false;
        return true;
    }

    private static boolean noneIn(Performance c, Set<String> round) {
        for (String singer : c.getSingers()) if (round.contains(singer)) return false;
        return true;
    }

    private static int repeats(Performance c, Set<String> round) {
        int count = 0;
        for (String singer : c.getSingers()) if (round.contains(singer)) count++;
        return count;
    }

    private static int freshCount(Performance c, Map<String, Integer> appeared) {
        int count = 0;
        for (String singer : c.getSingers()) if (appeared.getOrDefault(singer, 0) == 0) count++;
        return count;
    }

    private static int totalAppearances(Performance c, Map<String, Integer> appeared) {
        int total = 0;
        for (String singer : c.getSingers()) total += appeared.getOrDefault(singer, 0);
        return total;
    }
}
