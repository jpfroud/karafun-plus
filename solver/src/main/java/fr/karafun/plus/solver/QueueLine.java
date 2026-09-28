package fr.karafun.plus.solver;

import ai.timefold.solver.core.api.domain.entity.PlanningEntity;
import ai.timefold.solver.core.api.domain.variable.PlanningListVariable;
import ai.timefold.solver.core.api.domain.entity.PlanningPinToIndex;
import java.util.ArrayList;
import java.util.List;

@PlanningEntity
public class QueueLine {
    @PlanningListVariable
    private List<Performance> performances = new ArrayList<>();

    // The already announced next song and explicit staff prefix cannot move.
    @PlanningPinToIndex
    private int pinnedUntil;

    public QueueLine() { }
    public QueueLine(List<Performance> performances, int pinnedUntil) {
        this.performances = new ArrayList<>(performances);
        this.pinnedUntil = pinnedUntil;
    }
    public List<Performance> getPerformances() { return performances; }
    public void setPerformances(List<Performance> performances) { this.performances = performances; }
    public int getPinnedUntil() { return pinnedUntil; }
    public void setPinnedUntil(int pinnedUntil) { this.pinnedUntil = pinnedUntil; }
}
