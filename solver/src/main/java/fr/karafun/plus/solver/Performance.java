package fr.karafun.plus.solver;

import java.util.List;

/** One real song, not one singer: a duet has two physical performers. */
public class Performance {
    private String id;
    private String owner;
    private int ownerSongIndex;
    private List<String> singers;
    private List<String> groups;
    private int previousIndex;

    public Performance() { }

    public Performance(String id, String owner, int ownerSongIndex, List<String> singers,
                       List<String> groups, int previousIndex) {
        this.id = id;
        this.owner = owner;
        this.ownerSongIndex = ownerSongIndex;
        this.singers = singers;
        this.groups = groups;
        this.previousIndex = previousIndex;
    }

    public String getId() { return id; }
    public String getOwner() { return owner; }
    public int getOwnerSongIndex() { return ownerSongIndex; }
    public List<String> getSingers() { return singers; }
    public List<String> getGroups() { return groups; }
    public int getPreviousIndex() { return previousIndex; }
}
