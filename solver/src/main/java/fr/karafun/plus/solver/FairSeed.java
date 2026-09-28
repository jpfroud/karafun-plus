package fr.karafun.plus.solver;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Deterministic feasible starting order for short Timefold searches. A local
 * search that starts with adjacent second songs can otherwise spend its whole
 * budget repairing obvious first-turn violations in a 60-person bar.
 */
final class FairSeed {
    private FairSeed() { }

    static List<Performance> build(List<Performance> original, int pinnedUntil,
            Map<String, Integer> physicalCount, Map<String, Integer> pastAppearance,
            List<String> lastGroups) {
        List<Performance> ordered = new ArrayList<>(original.subList(0, pinnedUntil));
        List<Performance> remaining = new ArrayList<>(original.subList(pinnedUntil, original.size()));
        Map<String, Integer> appeared = new HashMap<>(physicalCount);
        Map<String, Integer> lastSeen = new HashMap<>(pastAppearance);
        List<String> previousGroups = lastGroups;
        for (int i = 0; i < ordered.size(); i++) {
            Performance song = ordered.get(i);
            for (String singer : song.getSingers()) {
                appeared.merge(singer, 1, Integer::sum);
                lastSeen.put(singer, i);
            }
            previousGroups = song.getGroups();
        }
        while (!remaining.isEmpty()) {
            // The smallest not-yet-scheduled title of each owner is eligible.
            Map<String, Integer> nextIndex = new HashMap<>();
            for (Performance song : remaining) nextIndex.merge(song.getOwner(),
                    song.getOwnerSongIndex(), Math::min);
            Performance best = null;
            int bestTier = Integer.MAX_VALUE, bestRepeatTable = Integer.MAX_VALUE;
            int bestRecency = Integer.MAX_VALUE;
            List<String> priorGroups = previousGroups;
            for (Performance candidate : remaining) {
                if (candidate.getOwnerSongIndex() != nextIndex.get(candidate.getOwner())) continue;
                int newSingers = 0;
                int recency = -1_000;
                for (String singer : candidate.getSingers()) {
                    if (appeared.getOrDefault(singer, 0) == 0) newSingers++;
                    recency = Math.max(recency, lastSeen.getOrDefault(singer, -1_000));
                }
                int tier = newSingers == candidate.getSingers().size() ? 0 : newSingers > 0 ? 1 : 2;
                int repeatTable = candidate.getGroups().stream().anyMatch(priorGroups::contains) ? 1 : 0;
                boolean preferable = best == null || tier < bestTier ||
                        (tier == bestTier && tier == 0 && repeatTable < bestRepeatTable) ||
                        (tier == bestTier && (tier != 0 || repeatTable == bestRepeatTable) &&
                                recency < bestRecency) ||
                        (tier == bestTier && repeatTable == bestRepeatTable && recency == bestRecency &&
                                candidate.getPreviousIndex() < best.getPreviousIndex());
                if (preferable) {
                    best = candidate;
                    bestTier = tier;
                    bestRepeatTable = repeatTable;
                    bestRecency = recency;
                }
            }
            if (best == null) throw new IllegalArgumentException("Liste personnelle incohérente");
            remaining.remove(best);
            int position = ordered.size();
            ordered.add(best);
            for (String singer : best.getSingers()) {
                appeared.merge(singer, 1, Integer::sum);
                lastSeen.put(singer, position);
            }
            previousGroups = best.getGroups();
        }
        return ordered;
    }
}
