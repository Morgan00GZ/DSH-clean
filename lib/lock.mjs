import fs from "node:fs";
import path from "node:path";

const MAX_CANDIDATES = 300;

function signature(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) {
      let n = 0;
      try { n = fs.readdirSync(abs).length; } catch { n = -1; }
      return { exists: true, sig: "d:" + st.mtimeMs + ":" + n };
    }
    return { exists: true, sig: "f:" + st.size + ":" + st.mtimeMs };
  } catch {
    return { exists: false, sig: "none" };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 把「待判定」的残留项与未归类目录转成绝对路径列表，去重后限流。 */
export function lockCandidates(residue, unknown, rootsById) {
  const out = [];
  const seen = new Set();
  const add = (rootId, rel) => {
    const base = rootsById.get(rootId);
    if (!base) return;
    const abs = path.join(base, rel.split("/").join(path.sep));
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rootId, rel, abs });
  };
  for (const x of residue) add(x.rootId, x.rel);
  for (const u of unknown) add(u.rootId, u.rel);
  return out.slice(0, MAX_CANDIDATES);
}

/**
 * LOCKED：间隔抽样两次元数据，抓「此刻正在被写入」的文件/目录。
 * 只多读两次 lstat，不读内容；全部候选共用一次等待，成本恒定。
 * 返回 { busy, gone, seconds }：busy = 正在写（这次别判）、gone = 抽样期间消失。
 */
export async function detectBusy(candidates, opts) {
  const waitMs = opts && opts.waitMs != null ? opts.waitMs : 900;
  const rounds = Math.max(1, (opts && opts.rounds) || 2);
  if (!candidates.length) return { busy: [], gone: [], seconds: 0 };
  const started = Date.now();
  const prev = candidates.map((c) => signature(c.abs));
  const busy = new Set();
  const gone = new Set();
  for (let i = 0; i < rounds; i++) {
    await sleep(waitMs);
    candidates.forEach((c, idx) => {
      const now = signature(c.abs);
      const p = prev[idx];
      if (p.exists && !now.exists) { gone.add(idx); return; }
      if (p.exists && now.exists && now.sig !== p.sig) busy.add(idx);
      prev[idx] = now;
    });
  }
  const busyList = [];
  const goneList = [];
  candidates.forEach((c, idx) => {
    if (gone.has(idx)) goneList.push(c);
    else if (busy.has(idx)) busyList.push(c);
  });
  return { busy: busyList, gone: goneList, seconds: (Date.now() - started) / 1000 };
}
