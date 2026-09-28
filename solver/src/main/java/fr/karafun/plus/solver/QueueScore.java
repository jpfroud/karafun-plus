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
 * Lexicographic bar policy. Hard: the singer's own playlist order. Medium:
 * physical first appearances and spacing, including duet guests. Soft: table
 * alternation and preserving published positions. The list variable itself
 * ensures that every song occurs exactly once.
 */
public class QueueScore implements EasyScoreCalculator<QueuePlan, HardMediumSoftScore> {
    @Override
    public HardMediumSoftScore calculateScore(QueuePlan plan) {
        if (plan.getLines() == null || plan.getLines().isEmpty()) {
            return HardMediumSoftScore.ZERO;
        }
        QueueLine line = plan.getLines().get(0);
        List<Performance> order = line.getPerformances();
        long hard = 0, medium = 0, soft = 0;
        Map<String, Integer> lastSongOfOwner = new HashMap<>();
        Map<String, Integer> lastAppearance = new HashMap<>(plan.getPastAppearance());
        Map<String, Integer> appeared = new HashMap<>(plan.getPhysicalCount());
        Set<String> round = new HashSet<>(plan.getRoundPeople());
        List<String> lastGroups = plan.getLastGroups();
        Set<String> groupsInRound = new HashSet<>(plan.getRoundGroups());
        Map<String, Integer> tableServed = new HashMap<>(plan.getTableServeCounts());

        for (int pos = 0; pos < order.size(); pos++) {
            Performance current = order.get(pos);
            Integer priorSong = lastSongOfOwner.put(current.getOwner(), current.getOwnerSongIndex());
            if (priorSong != null && priorSong >= current.getOwnerSongIndex()) hard -= 1;

            int firstTimers = 0, roundNew = 0;
            for (String singer : current.getSingers()) {
                if (appeared.getOrDefault(singer, 0) == 0) firstTimers++;
                if (!round.contains(singer)) roundNew++;
            }
            boolean futureFirstTimer = false, futureFullyFresh = false, futureRoundNew = false;
            Set<String> futureReadyOwners = new HashSet<>();
            for (int j = pos + 1; j < order.size(); j++) {
                Performance candidate = order.get(j);
                if (!futureReadyOwners.add(candidate.getOwner())) continue;
                int fresh = 0;
                for (String singer : candidate.getSingers()) {
                    if (!current.getSingers().contains(singer) && appeared.getOrDefault(singer, 0) == 0) fresh++;
                    if (!current.getSingers().contains(singer) && !round.contains(singer)) futureRoundNew = true;
                }
                if (fresh > 0) futureFirstTimer = true;
                if (fresh == candidate.getSingers().size()) futureFullyFresh = true;
            }
            // Un deuxième passage physique évitable n'est jamais une option
            // d'équité : les autres scores ne peuvent pas le compenser. Le
            // préfixe annoncé/manuellement fixé est une décision du bar.
            if (pos >= line.getPinnedUntil() &&
                    ((futureFullyFresh && firstTimers < current.getSingers().size()) ||
                     (futureFirstTimer && firstTimers == 0))) hard -= 1;
            if (futureFullyFresh && firstTimers < current.getSingers().size()) medium -= 4_000;
            else if (futureFirstTimer && firstTimers == 0) medium -= 2_000;
            if (futureRoundNew && roundNew == 0) medium -= 400;

            // For equally new duets, the guest seen at #1 is preferable to
            // someone who just sang at #3. The remembered positions are
            // negative, so pos=0 is the next song after the real history.
            for (String singer : current.getSingers()) {
                Integer last = lastAppearance.get(singer);
                if (last != null) {
                    int distance = pos - last;
                    int deficit = Math.max(0, 4 - distance);
                    medium -= (long) deficit * deficit * 180;
                } else if (pos > 0) {
                    // First physical appearance late in a published queue.
                    medium -= pos * 8L;
                }
                lastAppearance.put(singer, pos);
                appeared.merge(singer, 1, Integer::sum);
            }

            if (futureRoundNew && current.getSingers().stream().allMatch(round::contains)) {
                medium -= 300;
            }
            if (roundNew == 0 && !futureRoundNew) round.clear();
            round.addAll(current.getSingers());

            if (plan.isTableRotation()) {
                // Le tour de table est indépendant du tour des personnes :
                // lorsqu'une autre table a un titre prêt, une table déjà
                // servie dans ce tour attend. Un duo inter-table sert les deux.
                Set<String> availableGroups = new HashSet<>(current.getGroups());
                Set<String> readyOwners = new HashSet<>();
                readyOwners.add(current.getOwner());
                for (int j = pos + 1; j < order.size(); j++) {
                    Performance candidate = order.get(j);
                    if (readyOwners.add(candidate.getOwner())) availableGroups.addAll(candidate.getGroups());
                }
                if (groupsInRound.containsAll(availableGroups)) groupsInRound.clear();
                boolean freshTable = current.getGroups().stream().anyMatch(g -> !groupsInRound.contains(g));
                boolean otherUnserved = availableGroups.stream()
                        .anyMatch(g -> !groupsInRound.contains(g) && !current.getGroups().contains(g));
                if (!freshTable && otherUnserved) medium -= 1_200;
                List<String> previousGroups = lastGroups;
                boolean overlapsLast = current.getGroups().stream().anyMatch(previousGroups::contains);
                boolean otherTableReady = availableGroups.stream().anyMatch(g -> !previousGroups.contains(g));
                if (overlapsLast && otherTableReady) medium -= 350;

                if (plan.isWeightedTables()) {
                    // Crédit consommé / racine(chanteurs prêts) : une grande
                    // table revient plus souvent sans monopoliser deux places
                    // consécutives quand une autre table attend.
                    Set<String> options = new HashSet<>(availableGroups);
                    if (otherTableReady) options.removeAll(previousGroups);
                    double bestDebt = options.stream().mapToDouble(g -> debt(g, tableServed,
                            plan.getGroupReadyCounts())).min().orElse(0);
                    double chosenDebt = current.getGroups().stream().mapToDouble(g -> debt(g, tableServed,
                            plan.getGroupReadyCounts())).min().orElse(0);
                    if (chosenDebt > bestDebt) medium -= Math.round((chosenDebt - bestDebt) * 300);
                    else if (Math.abs(chosenDebt - bestDebt) < 0.000_001) {
                        int largestEqualCredit = options.stream()
                                .filter(g -> Math.abs(debt(g, tableServed,
                                        plan.getGroupReadyCounts()) - bestDebt) < 0.000_001)
                                .mapToInt(g -> plan.getGroupReadyCounts().getOrDefault(g, 1)).max().orElse(1);
                        int chosenSize = current.getGroups().stream()
                                .mapToInt(g -> plan.getGroupReadyCounts().getOrDefault(g, 1)).max().orElse(1);
                        medium -= Math.max(0, largestEqualCredit - chosenSize) * 12L;
                    }
                }
                groupsInRound.addAll(current.getGroups());
                for (String group : current.getGroups()) tableServed.merge(group, 1, Integer::sum);
            }
            lastGroups = current.getGroups();

            int displacement = Math.abs(pos - current.getPreviousIndex());
            soft -= (long) displacement * (current.getPreviousIndex() < 5 ? 10 : 3);
        }
        return HardMediumSoftScore.of(hard, medium, soft);
    }

    private static double debt(String group, Map<String, Integer> served, Map<String, Integer> size) {
        return served.getOrDefault(group, 0) / Math.sqrt(Math.max(1, size.getOrDefault(group, 1)));
    }
}
