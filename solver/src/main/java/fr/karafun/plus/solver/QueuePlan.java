package fr.karafun.plus.solver;

import ai.timefold.solver.core.api.domain.solution.PlanningEntityCollectionProperty;
import ai.timefold.solver.core.api.domain.solution.PlanningScore;
import ai.timefold.solver.core.api.domain.solution.PlanningSolution;
import ai.timefold.solver.core.api.domain.valuerange.ValueRangeProvider;
import ai.timefold.solver.core.api.score.HardMediumSoftScore;
import java.util.List;
import java.util.Map;
import java.util.Set;

@PlanningSolution
public class QueuePlan {
    /** Share of a round given to each table: per singer, equal, or square root. */
    public enum Rotation { PEOPLE, EQUAL, SQRT }

    @ValueRangeProvider
    private List<Performance> performances;
    @PlanningEntityCollectionProperty
    private List<QueueLine> lines;
    @PlanningScore
    private HardMediumSoftScore score;

    private Map<String, Integer> pastAppearance;
    private Map<String, Integer> physicalCount;
    private Map<String, Integer> readyAt;
    private List<String> lastGroups;
    private Set<String> roundPeople;
    private Map<String, Double> roundUse;
    private Map<String, Integer> roundApps;
    private int roundCap;
    private int spacing;
    private Map<String, Double> personWeights;
    private Map<String, Double> tableWeights;
    private List<List<String>> history;
    private Rotation rotation;
    private boolean interleaveArrivals;

    public QueuePlan() { }
    public QueuePlan(List<Performance> performances, QueueLine line,
                     Map<String, Integer> pastAppearance, Map<String, Integer> physicalCount,
                     Map<String, Integer> readyAt, List<String> lastGroups, Set<String> roundPeople,
                     Map<String, Double> roundUse, Map<String, Double> personWeights,
                     Map<String, Double> tableWeights, List<List<String>> history,
                     Rotation rotation, boolean interleaveArrivals) {
        this(performances, line, pastAppearance, physicalCount, readyAt, lastGroups, roundPeople,
                roundUse, Map.of(), 0, 0, personWeights, tableWeights, history, rotation, interleaveArrivals);
    }
    /** roundApps: stage appearances in the current round; roundCap and spacing: 0 disables them. */
    public QueuePlan(List<Performance> performances, QueueLine line,
                     Map<String, Integer> pastAppearance, Map<String, Integer> physicalCount,
                     Map<String, Integer> readyAt, List<String> lastGroups, Set<String> roundPeople,
                     Map<String, Double> roundUse, Map<String, Integer> roundApps, int roundCap, int spacing,
                     Map<String, Double> personWeights, Map<String, Double> tableWeights,
                     List<List<String>> history, Rotation rotation, boolean interleaveArrivals) {
        this.performances = performances;
        this.lines = List.of(line);
        this.pastAppearance = pastAppearance;
        this.physicalCount = physicalCount;
        this.readyAt = readyAt;
        this.lastGroups = lastGroups;
        this.roundPeople = roundPeople;
        this.roundUse = roundUse;
        this.roundApps = roundApps;
        this.roundCap = roundCap;
        this.spacing = spacing;
        this.personWeights = personWeights;
        this.tableWeights = tableWeights;
        this.history = history;
        this.rotation = rotation;
        this.interleaveArrivals = interleaveArrivals;
    }
    public List<Performance> getPerformances() { return performances; }
    public List<QueueLine> getLines() { return lines; }
    public HardMediumSoftScore getScore() { return score; }
    public void setScore(HardMediumSoftScore score) { this.score = score; }
    public Map<String, Integer> getPastAppearance() { return pastAppearance; }
    public Map<String, Integer> getPhysicalCount() { return physicalCount; }
    public Map<String, Integer> getReadyAt() { return readyAt; }
    public List<String> getLastGroups() { return lastGroups; }
    public Set<String> getRoundPeople() { return roundPeople; }
    public Map<String, Double> getRoundUse() { return roundUse; }
    public Map<String, Integer> getRoundApps() { return roundApps; }
    public int getRoundCap() { return roundCap; }
    public int getSpacing() { return spacing; }
    public Map<String, Double> getPersonWeights() { return personWeights; }
    public Map<String, Double> getTableWeights() { return tableWeights; }
    public List<List<String>> getHistory() { return history; }
    public Rotation getRotation() { return rotation; }
    public boolean isInterleaveArrivals() { return interleaveArrivals; }
}
