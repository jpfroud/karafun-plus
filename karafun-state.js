'use strict';

// Les messages de file et de lecture peuvent arriver séparément.
// Un identifiant explicite reste prioritaire, même pendant cette transition.
function analyzeState(q = [], st = {}) {
  st = st || {};
  const cur = st.songPlaying || st.current || null;
  const stateStr = String(st.state || '').toLowerCase();
  const active = /^(playing|play|paused|pause)$/.test(stateStr);
  let curIdx = -1;
  if (active && cur) {
    if (cur.queueId != null) curIdx = q.findIndex(it => it.queueId === cur.queueId);
    else {
      curIdx = q.findIndex(it => Number(it.songId) === Number(cur.songId || (cur.song && cur.song.id)) &&
        !!it.community === !!cur.community && (!cur.singer || it.singer === cur.singer));
      if (curIdx < 0) curIdx = q.findIndex(it => it.title && it.title === (cur.title || (cur.song && cur.song.title)));
    }
  }
  if (active && !cur && q.length) curIdx = 0;
  if (!stateStr && !cur) curIdx = q.findIndex(it => /play/i.test(String(it.status || '')));
  const current = curIdx >= 0 ? q[curIdx] : (active && cur ? cur : null);
  const upcoming = q.filter((it, i) => i !== curIdx && !(curIdx >= 0 && i < curIdx));
  return { current, upcoming, stateStr, q };
}

module.exports = { analyzeState };
