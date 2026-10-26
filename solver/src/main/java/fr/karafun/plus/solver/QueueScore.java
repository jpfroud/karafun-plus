package fr.karafun.plus.solver;

import ai.timefold.solver.core.api.score.HardMediumSoftScore;
import ai.timefold.solver.core.api.score.calculator.EasyScoreCalculator;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/**
 * Same bar policy as lib/scheduler/rotation.js#_pick, evaluated on a whole planned queue.
 * Hard: the singer's own playlist order, first appearances of the evening
 * before anyone's return, at most roundCap stage appearances per person in a
 * round, and `spacing` other songs before a person returns when another
 * passage of the round allows it. Medium: once per round (with bonus/malus credits,
 * a bonus's extra passages spread out over the round),
 * nobody sees someone sing twice during their own wait when another allowed
 * passage avoids it (after the table rule in EQUAL and SQRT), first
 * appearances first come, first served (before the table rule in PEOPLE, a
 * tie-break of the table share in EQUAL and SQRT), no table twice in a row
 * when another can sing, spacing of a returning person, and each table's
 * share of the round. Soft: stability versus the order proposed by the Node
 * process.
 */
public class QueueScore implements EasyScoreCalculator<QueuePlan, HardMediumSoftScore> {
    private static final double EPS = 1e-9;
    private static final int UNKNOWN = -1000;
    // Usual spacing (DEFAULTS.spacingSongs in lib/scheduler/common.js): room a
    // spread-out bonus keeps between its last passages of a round.
    private static final int USUAL_SPACING = 3;

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
        Map<String, Integer> apps = new HashMap<>(plan.getRoundApps() == null ? Map.of() : plan.getRoundApps());
        Set<String> owed = new HashSet<>(plan.getRoundOwed() == null ? Set.of() : plan.getRoundOwed());
        final int cap = plan.getRoundCap(), spacing = plan.getSpacing();
        List<List<String>> history = new ArrayList<>(plan.getHistory());
        List<String> previous = plan.getLastGroups();
        boolean anyBonus = false;
        for (double w : plan.getPersonWeights().values()) anyBonus |= w > 1 + EPS;

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
            // A duo whose singer is already on stage `cap` times in this round
            // waits for the next one; the round ends when nothing else can sing.
            // People left without a passage when the round closes (their duo
            // waited for someone at the cap) lead the next round, all of them,
            // until each has sung in it.
            if (candidates.stream().allMatch(c -> capped(c, apps, cap) || allIn(c, round))) {
                owed.clear();
                for (Performance c : candidates) for (String singer : c.getSingers()) if (!round.contains(singer)) owed.add(singer);
                int resets = 0;
                do { resetRound(round, roundUse); apps.clear(); resets++; }
                while (resets < 4 && candidates.stream().allMatch(c -> capped(c, apps, cap) || allIn(c, round)));
            }
            List<Performance> open = new ArrayList<>();
            for (Performance c : candidates) if (!capped(c, apps, cap)) open.add(c);
            if (open.isEmpty()) open.addAll(candidates);

            // Bonus spread out (lib/scheduler/rotation.js#_pick, `early`): the
            // owner of a title, weighing w > 1, whose round is not over comes
            // back only about n/w passages after their last one (n: people of
            // the current round, a title ready or already on stage in it),
            // unless the round no longer has room for the passages they still
            // owe it (their credit, plus the new duos they are invited to; one:
            // no other new passage left; k >= 2: at most k * max(3, spacing)
            // left). Room only counts new passages sharing nobody with the
            // held one. A guest's bonus never holds the duo of the person who
            // invites them. Spacing still wins (fallback below). Only computed
            // when someone in the plan has a bonus.
            final int at = pos;
            Predicate<Performance> early = null;
            if (anyBonus) {
                List<Performance> fresh = new ArrayList<>();
                for (Performance c : open) if (repeats(c, round, apps) == 0) fresh.add(c);
                Set<String> people = new HashSet<>(owners);
                people.addAll(apps.keySet());
                final int roundSize = people.size();
                early = c -> {
                    String singer = c.getOwner();
                    double w = weight(plan, singer);
                    int last = lastSeen.getOrDefault(singer, UNKNOWN);
                    if (w <= 1 + EPS || last <= UNKNOWN || round.contains(singer)) return false;
                    if (at - last >= roundSize / w - EPS) return false;
                    int others = 0, invited = 0;
                    for (Performance other : fresh) {
                        if (other == c) continue;
                        if (Collections.disjoint(other.getSingers(), c.getSingers())) others++;
                        else if (other.getSingers().contains(singer) && !singer.equals(other.getOwner())) invited++;
                    }
                    int left = (int) Math.ceil((1 - roundUse.getOrDefault(singer, 0.0)) * w - EPS) + invited;
                    return others > (left > 1 ? left * Math.max(USUAL_SPACING, spacing) : 0);
                };
            }
            List<Performance> tier = firstAppearances(open, appeared);
            List<Performance> choices = unhurried(oncePerRound(preferOwed(tier, owed, round), round, apps), early);
            // Spacing: when every fair passage brings back someone who sang
            // in the last `spacing` songs, another passage of the round goes
            // first, never someone who already sang in this round. The table
            // rule wins: spacing never hands the mic back to the last table.
            if (spacing > 0) {
                List<Performance> wellSpaced = new ArrayList<>();
                for (Performance c : choices) if (spaced(c, lastSeen, at, spacing)) wellSpaced.add(c);
                List<Performance> spacedTier = tier;
                if (wellSpaced.isEmpty()) {
                    List<Performance> others = new ArrayList<>();
                    for (Performance c : open) if (spaced(c, lastSeen, at, spacing) && repeats(c, round, apps) < c.getSingers().size()) others.add(c);
                    if (!others.isEmpty()) {
                        spacedTier = firstAppearances(others, appeared);
                        wellSpaced = unhurried(oncePerRound(preferOwed(spacedTier, owed, round), round, apps), early);
                    }
                }
                if (!wellSpaced.isEmpty() && (offTable(wellSpaced, prior) || !offTable(choices, prior))) {
                    choices = wellSpaced;
                    tier = spacedTier;
                }
            }
            final List<Performance> chosen = choices;
            // A table that arrives at once is interleaved with people who
            // have not sung since any waiting person started waiting.
            boolean streak = plan.isInterleaveArrivals() && !prior.isEmpty() &&
                    chosen.stream().allMatch(c -> overlaps(c.getGroups(), prior));
            List<Performance> alternates = new ArrayList<>();
            if (streak) {
                for (Performance c : open) {
                    if (chosen.contains(c) || overlaps(c.getGroups(), prior)) continue;
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
            // Patience (lib/scheduler/rotation.js#_patient): among the allowed
            // passages, those that make the fewest waiting people see someone
            // sing twice. PEOPLE: before the table rule, which only breaks ties.
            // EQUAL and SQRT: the table rule first, then patience among the
            // other tables. Node applies it before the plan, so a plan that
            // breaks it is never followed: it costs almost as much as leaving
            // the fair choices. Node's patience also admits the least-doubling
            // other-table passages whose duet guests are not cooling down
            // (cooldowns are not sent here); a plan choosing one of those is
            // followed by Node although it is scored here as a patience break.
            List<Performance> patient = allowedNow;
            int[] doubles = null;
            int least = 0;
            if (allowedNow.size() > 1) {
                int[] seen = new int[allowedNow.size()];
                boolean anySeen = false;
                for (int k = 0; k < seen.length; k++) {
                    seen[k] = lastSung(allowedNow.get(k), pos, lastSeen, appeared, plan);
                    anySeen |= seen[k] > UNKNOWN;
                }
                if (anySeen) {
                    int[] waits = waitStarts(candidates, lastSeen, plan);
                    doubles = new int[seen.length];
                    for (int k = 0; k < seen.length; k++) doubles[k] = doubled(allowedNow.get(k), seen[k], waits, lastSeen, owners, plan);
                    int fewest = Integer.MAX_VALUE, most = Integer.MIN_VALUE;
                    for (int count : doubles) { fewest = Math.min(fewest, count); most = Math.max(most, count); }
                    if (most > fewest) {
                        // Table rotation modes: patience only chooses among the
                        // other tables; the last table's passages stay for the
                        // table rule below, as in Node.
                        boolean tablesFirst = plan.getRotation() != QueuePlan.Rotation.PEOPLE;
                        boolean[] off = new boolean[seen.length];
                        boolean anyOff = false;
                        for (int k = 0; k < seen.length; k++) {
                            off[k] = tablesFirst && !overlaps(allowedNow.get(k).getGroups(), prior);
                            anyOff |= off[k];
                        }
                        least = Integer.MAX_VALUE;
                        for (int k = 0; k < seen.length; k++) if (!anyOff || off[k]) least = Math.min(least, doubles[k]);
                        patient = new ArrayList<>();
                        for (int k = 0; k < seen.length; k++) {
                            if ((anyOff && !off[k]) || doubles[k] == least) patient.add(allowedNow.get(k));
                        }
                    }
                }
            }
            // First appearances, first come, first served (rotation.js#_pick):
            // among passages that only bring people never on stage yet, the
            // owner whose wait started first (addedOrder; a duet counts by its
            // owner). PEOPLE: right after patience, before the table rule,
            // which then only breaks ties among the earliest; EQUAL and SQRT:
            // it only breaks ties of the table share (below).
            boolean firstTurn = patient.size() > 1 && !plan.getAddedOrder().isEmpty() &&
                    patient.stream().allMatch(c -> freshCount(c, appeared) == c.getSingers().size());
            boolean byTables = plan.getRotation() != QueuePlan.Rotation.PEOPLE;
            List<Performance> fair = patient;
            if (firstTurn && !byTables) {
                int first = Integer.MAX_VALUE;
                for (Performance c : patient) first = Math.min(first, added(plan, c));
                fair = new ArrayList<>();
                for (Performance c : patient) if (added(plan, c) == first) fair.add(c);
            }
            boolean earliest = fair.contains(current);
            if (!pinned && !allowedNow.contains(current)) {
                if (!tier.contains(current)) hard -= 1;
                else if (!choices.contains(current)) medium -= 5_000;
                // Otherwise only the streak was avoidable: counted below.
            } else if (!pinned && !patient.contains(current)) {
                // Below the 5_000 of leaving the fair choices: more doubles cost
                // a little more, never as much as breaking « once per round ».
                int extra = doubles[allowedNow.indexOf(current)] - least;
                medium -= 4_000L + Math.min(900L, 100L * Math.max(0, extra - 1));
            } else if (!pinned && !earliest) {
                // Below patience, above the table rule and the share it
                // overrides in PEOPLE: a plan never serves a later first
                // appearance before an earlier one.
                medium -= 3_000;
            }

            // PEOPLE serving the earliest first appearance: the table rule and
            // the table share below only compare it with the other earliest.
            final List<Performance> tableChoices = earliest && fair != patient ? fair : candidates;
            boolean overlapsPrevious = !prior.isEmpty() && overlaps(current.getGroups(), prior);
            if (overlapsPrevious && tableChoices.stream().anyMatch(c -> !overlaps(c.getGroups(), prior))) {
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

            // Each table's share of the round, as in lib/scheduler/rotation.js.
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
            for (Performance c : earliest ? fair : patient) best = Math.max(best, need(c, deficits));
            double picked = need(current, deficits);
            if (best > picked + EPS && best != Double.NEGATIVE_INFINITY) {
                medium -= Math.round((best - picked) * 150);
            }
            // EQUAL and SQRT: at the same share, and no worse for the table
            // rule, the first appearance added first goes first.
            if (firstTurn && byTables && !pinned && patient.contains(current)) {
                int mine = added(plan, current);
                for (Performance c : patient) {
                    if (added(plan, c) < mine && Math.abs(need(c, deficits) - picked) <= EPS &&
                            (overlapsPrevious || !overlaps(c.getGroups(), prior))) {
                        medium -= 200;
                        break;
                    }
                }
            }

            // A passage granted by the interleave rule to someone who already
            // sang in this round is taken from their next round
            // (lib/scheduler/rotation.js). The JS rule also charges an announced
            // next passage caught up by an arrival (reservedNext.borrowable);
            // that pinned head is not simulated here, and the local rule still
            // decides whether a plan is adopted.
            boolean borrowed = alternates.contains(current);
            for (String singer : current.getSingers()) {
                lastSeen.put(singer, pos);
                appeared.merge(singer, 1, Integer::sum);
                apps.merge(singer, 1, Integer::sum);
                owed.remove(singer);
                useRound(round, roundUse, singer, weight(plan, singer), borrowed && singer.equals(current.getOwner()));
            }
            history.add(current.getGroups());
            previous = current.getGroups();

            int displacement = Math.abs(pos - current.getPreviousIndex());
            soft -= (long) displacement * (current.getPreviousIndex() < 5 ? 10 : 3);
        }
        return HardMediumSoftScore.of(hard, medium, soft);
    }

    private static List<Performance> firstAppearances(List<Performance> candidates, Map<String, Integer> appeared) {
        List<Performance> tier = new ArrayList<>();
        for (Performance c : candidates) if (freshCount(c, appeared) == c.getSingers().size()) tier.add(c);
        if (!tier.isEmpty()) return tier;
        int least = Integer.MAX_VALUE;
        for (Performance c : candidates) {
            if (freshCount(c, appeared) > 0) least = Math.min(least, totalAppearances(c, appeared));
        }
        for (Performance c : candidates) {
            if (freshCount(c, appeared) > 0 && totalAppearances(c, appeared) == least) tier.add(c);
        }
        if (tier.isEmpty()) tier.addAll(candidates);
        return tier;
    }

    // Without the passages held back by the bonus spread, unless none is left.
    private static List<Performance> unhurried(List<Performance> list, Predicate<Performance> early) {
        if (early == null) return list;
        List<Performance> due = new ArrayList<>();
        for (Performance c : list) if (!early.test(c)) due.add(c);
        return due.isEmpty() ? list : due;
    }

    private static List<Performance> oncePerRound(List<Performance> tier, Set<String> round, Map<String, Integer> apps) {
        List<Performance> choices = new ArrayList<>();
        for (Performance c : tier) if (repeats(c, round, apps) == 0) choices.add(c);
        if (!choices.isEmpty()) return choices;
        int fewest = Integer.MAX_VALUE;
        for (Performance c : tier) {
            int repeats = repeats(c, round, apps);
            if (repeats < c.getSingers().size()) fewest = Math.min(fewest, repeats);
        }
        for (Performance c : tier) {
            int repeats = repeats(c, round, apps);
            if (repeats < c.getSingers().size() && repeats == fewest) choices.add(c);
        }
        if (choices.isEmpty()) choices.addAll(tier);
        return choices;
    }

    // Owed people go first, even when their duo brings back someone who
    // already sang in this round (same as lib/scheduler/rotation.js).
    private static List<Performance> preferOwed(List<Performance> list, Set<String> owed, Set<String> round) {
        if (owed.isEmpty()) return list;
        List<Performance> owing = new ArrayList<>();
        for (Performance c : list) for (String singer : c.getSingers()) {
            if (owed.contains(singer) && !round.contains(singer)) { owing.add(c); break; }
        }
        return owing.isEmpty() ? list : owing;
    }

    private static boolean offTable(List<Performance> list, List<String> prior) {
        for (Performance c : list) if (prior.isEmpty() || !overlaps(c.getGroups(), prior)) return true;
        return false;
    }

    private static boolean capped(Performance c, Map<String, Integer> apps, int cap) {
        if (cap <= 0) return false;
        for (String singer : c.getSingers()) if (apps.getOrDefault(singer, 0) >= cap) return true;
        return false;
    }

    // Same as lib/scheduler/rotation.js: nobody who sang in the last `spacing` songs.
    private static boolean spaced(Performance c, Map<String, Integer> lastSeen, int pos, int spacing) {
        for (String singer : c.getSingers()) {
            Integer last = lastSeen.get(singer);
            if (last != null && last > UNKNOWN && pos - last <= spacing) return false;
        }
        return true;
    }

    // Wait start of each protected person (owner of a candidate title, no
    // malus): their last appearance, or when their list stopped being empty,
    // as for the interleave rule. Sorted, for doubled().
    private static int[] waitStarts(List<Performance> candidates, Map<String, Integer> lastSeen, QueuePlan plan) {
        int[] waits = new int[candidates.size()];
        int count = 0;
        for (Performance other : candidates) {
            String owner = other.getOwner();
            if (weight(plan, owner) < 1 - EPS) continue;
            waits[count++] = Math.max(lastSeen.getOrDefault(owner, UNKNOWN), plan.getReadyAt().getOrDefault(owner, UNKNOWN));
        }
        int[] out = Arrays.copyOf(waits, count);
        Arrays.sort(out);
        return out;
    }

    // Last appearance of a singer of `c` who already sang, or UNKNOWN. A bonus
    // singer counts only until rested (two other passages since), as in Node.
    private static int lastSung(Performance c, int pos, Map<String, Integer> lastSeen, Map<String, Integer> appeared,
                                QueuePlan plan) {
        int seen = UNKNOWN;
        for (String singer : c.getSingers()) {
            if (appeared.getOrDefault(singer, 0) == 0) continue;
            int last = lastSeen.getOrDefault(singer, UNKNOWN);
            if (weight(plan, singer) > 1 + EPS && pos - last >= 3) continue;
            seen = Math.max(seen, last);
        }
        return seen;
    }

    // Same as lib/scheduler/rotation.js#_patient: protected people whose wait
    // started before `seen`, the last appearance of a singer of `c`. `owners`:
    // the candidates' owners, whose wait starts are in `waits`.
    private static int doubled(Performance c, int seen, int[] waits, Map<String, Integer> lastSeen,
                               Set<String> owners, QueuePlan plan) {
        if (seen <= UNKNOWN) return 0;
        int lo = 0, hi = waits.length;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (waits[mid] < seen) lo = mid + 1; else hi = mid;
        }
        // The singers of `c` do not count against themselves.
        for (String singer : c.getSingers()) {
            if (weight(plan, singer) < 1 - EPS) continue;
            int wait = Math.max(lastSeen.getOrDefault(singer, UNKNOWN), plan.getReadyAt().getOrDefault(singer, UNKNOWN));
            if (wait < seen && owners.contains(singer)) lo--;
        }
        return lo;
    }

    // Rank of the time the owner's wait started (first come, first served).
    private static int added(QueuePlan plan, Performance c) {
        return plan.getAddedOrder().getOrDefault(c.getOwner(), 0);
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
                case SQRT -> Math.sqrt(Math.max(sum, plan.getGroupSizes().getOrDefault(entry.getKey(), 0.0)));
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

    private static void useRound(Set<String> round, Map<String, Double> use, String person, double weight,
                                 boolean borrowed) {
        double cost = 1 / weight;
        // Without bonus or malus, a passage that is not borrowed costs nothing
        // more to someone already counted in this round (duet guest), debt or not.
        if (Math.abs(cost - 1) < EPS && !borrowed && round.contains(person)) return;
        boolean already = borrowed && round.contains(person);
        if (Math.abs(cost - 1) < EPS && !use.containsKey(person) && !already) { round.add(person); return; }
        double used = (use.containsKey(person) ? use.get(person) : (already ? 1.0 : 0.0)) + cost;
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

    // Singers of this passage already counted in the round. A debt (a
    // passage taken early, a malus) puts its debtor in the round without a
    // stage appearance; it weighs on the debtor's own title. As the guest of
    // an owner still new in the round, the debtor counts once really on
    // stage, so that owner does not pay the guest's debt. An owner already
    // counted in the round (passage or debt) changes nothing: the guest does
    // not turn the duet into a new passage (same as lib/scheduler/rotation.js).
    private static int repeats(Performance c, Set<String> round, Map<String, Integer> apps) {
        boolean ownerIn = round.contains(c.getOwner());
        int count = 0;
        for (String singer : c.getSingers()) {
            if (round.contains(singer) && (ownerIn || singer.equals(c.getOwner()) || apps.getOrDefault(singer, 0) > 0)) count++;
        }
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
