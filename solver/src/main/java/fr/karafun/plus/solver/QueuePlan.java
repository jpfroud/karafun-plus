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
    @ValueRangeProvider
    private List<Performance> performances;
    @PlanningEntityCollectionProperty
    private List<QueueLine> lines;
    @PlanningScore
    private HardMediumSoftScore score;

    private Map<String, Integer> pastAppearance;
    private Map<String, Integer> physicalCount;
    private List<String> lastGroups;
    private Set<String> roundPeople;
    private Set<String> roundGroups;
    private Map<String, Integer> tableServeCounts;
    private Map<String, Integer> groupReadyCounts;
    private boolean tableRotation;
    private boolean weightedTables;

    public QueuePlan() { }
    public QueuePlan(List<Performance> performances, QueueLine line,
                     Map<String, Integer> pastAppearance, Map<String, Integer> physicalCount,
                     List<String> lastGroups, Set<String> roundPeople, Set<String> roundGroups,
                     Map<String, Integer> tableServeCounts, Map<String, Integer> groupReadyCounts,
                     boolean tableRotation, boolean weightedTables) {
        this.performances = performances;
        this.lines = List.of(line);
        this.pastAppearance = pastAppearance;
        this.physicalCount = physicalCount;
        this.lastGroups = lastGroups;
        this.roundPeople = roundPeople;
        this.roundGroups = roundGroups;
        this.tableServeCounts = tableServeCounts;
        this.groupReadyCounts = groupReadyCounts;
        this.tableRotation = tableRotation;
        this.weightedTables = weightedTables;
    }
    public List<Performance> getPerformances() { return performances; }
    public List<QueueLine> getLines() { return lines; }
    public HardMediumSoftScore getScore() { return score; }
    public void setScore(HardMediumSoftScore score) { this.score = score; }
    public Map<String, Integer> getPastAppearance() { return pastAppearance; }
    public Map<String, Integer> getPhysicalCount() { return physicalCount; }
    public List<String> getLastGroups() { return lastGroups; }
    public Set<String> getRoundPeople() { return roundPeople; }
    public Set<String> getRoundGroups() { return roundGroups; }
    public Map<String, Integer> getTableServeCounts() { return tableServeCounts; }
    public Map<String, Integer> getGroupReadyCounts() { return groupReadyCounts; }
    public boolean isTableRotation() { return tableRotation; }
    public boolean isWeightedTables() { return weightedTables; }
}
