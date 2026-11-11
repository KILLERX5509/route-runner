// Route ordering for one driver with a fixed start point.
//
// cost[i][j] is the cost of driving from i to j (seconds or meters). It may be
// asymmetric (one-way streets). Node 0 is the start (your location); nodes
// 1..n-1 are the stops.
//
// end: 'open'   - finish at whichever stop is best
//      'return' - come back to the start at the end
//      <number> - finish at that specific stop
//
// Method: nearest-neighbour route, then local search (2-opt segment reversal
// and or-opt segment moves), then repeated random "kicks" + local search for a
// fixed time budget, keeping the best route found. For 50 stops this lands on
// or very near the best possible order in well under a second.

const BIG = 1e12;

export function solveRoute(cost, opts = {}) {
  const n = cost.length;
  const end = opts.end ?? 'open';
  const timeMs = opts.timeMs ?? 500;
  const rand = mulberry32(opts.seed ?? 20261110);
  const check = !!opts._check;

  if (n <= 1) return { order: [], cost: 0 };

  // Augmented matrix with an extra end node E = n.
  //   open:   reaching E costs nothing from anywhere
  //   return: reaching E costs the drive back to the start
  const E = n;
  const N = n + 1;
  const fixedEnd = typeof end === 'number' && end > 0 && end < n ? end : -1;
  const M = new Array(N);
  for (let i = 0; i < N; i++) M[i] = new Float64Array(N);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i][j] = i === j ? 0 : safe(cost[i][j]);
    M[i][E] = end === 'return' ? (i === 0 ? 0 : safe(cost[i][0])) : 0;
  }

  const endNode = fixedEnd >= 0 ? fixedEnd : E;
  const interior = [];
  for (let i = 1; i < n; i++) if (i !== fixedEnd) interior.push(i);

  // Small routes: solve exactly.
  if (interior.length <= 13) {
    const exact = heldKarp(M, interior, endNode);
    const order = exact.slice(1, -1);
    if (fixedEnd >= 0) order.push(fixedEnd);
    return { order, cost: pathCost(M, exact) };
  }

  let best = localSearch(M, nearestNeighbor(M, interior, endNode), check);
  let bestCost = pathCost(M, best);

  if (interior.length >= 4) {
    // A second, different starting point: the stops sorted by cost from start, reversed.
    const far = interior.slice().sort((a, b) => M[0][b] - M[0][a]);
    const alt = localSearch(M, [0, ...far, endNode], check);
    const altCost = pathCost(M, alt);
    if (altCost < bestCost) { best = alt; bestCost = altCost; }

    let cur = best, curCost = bestCost;
    const t0 = now();
    const maxIters = 400 + interior.length * 60;
    for (let it = 0; it < maxIters && now() - t0 < timeMs; it++) {
      const cand = localSearch(M, doubleBridge(cur, rand), check);
      const c = pathCost(M, cand);
      if (c < curCost - 1e-9) {
        cur = cand; curCost = c;
        if (c < bestCost - 1e-9) { best = cand; bestCost = c; }
      } else if (it % 50 === 49) {
        cur = best; curCost = bestCost; // drift back to the best route now and then
      }
    }
  }

  const order = best.slice(1, -1);
  if (fixedEnd >= 0) order.push(fixedEnd);
  return { order, cost: bestCost };
}

// Cost of visiting `order` (stop node indices) starting from node 0.
export function routeCost(cost, order, end = 'open') {
  let c = 0, prev = 0;
  for (const k of order) { c += safe(cost[prev][k]); prev = k; }
  if (end === 'return' && order.length) c += safe(cost[prev][0]);
  return c;
}

function safe(v) {
  return v == null || !Number.isFinite(v) ? BIG : v;
}

// Exact dynamic programming over subsets (Held-Karp), fine up to ~13 stops.
function heldKarp(M, interior, endNode) {
  const m = interior.length;
  if (m === 0) return [0, endNode];
  const S = 1 << m;
  const dp = new Float64Array(S * m).fill(Infinity);
  const par = new Int16Array(S * m).fill(-1);
  for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = M[0][interior[j]];
  for (let mask = 1; mask < S; mask++) {
    for (let j = 0; j < m; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * m + j];
      if (cur === Infinity) continue;
      for (let k = 0; k < m; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k);
        const v = cur + M[interior[j]][interior[k]];
        if (v < dp[nm * m + k]) { dp[nm * m + k] = v; par[nm * m + k] = j; }
      }
    }
  }
  const full = S - 1;
  let bestJ = 0, bestV = Infinity;
  for (let j = 0; j < m; j++) {
    const v = dp[full * m + j] + M[interior[j]][endNode];
    if (v < bestV) { bestV = v; bestJ = j; }
  }
  const rev = [];
  let mask = full, j = bestJ;
  while (j !== -1) {
    rev.push(interior[j]);
    const pj = par[mask * m + j];
    mask ^= 1 << j;
    j = pj;
  }
  return [0, ...rev.reverse(), endNode];
}

function nearestNeighbor(M, interior, endNode) {
  const left = new Set(interior);
  const path = [0];
  let cur = 0;
  while (left.size) {
    let pick = -1, pc = Infinity;
    for (const k of left) if (M[cur][k] < pc) { pc = M[cur][k]; pick = k; }
    left.delete(pick);
    path.push(pick);
    cur = pick;
  }
  path.push(endNode);
  return path;
}

function pathCost(M, p) {
  let c = 0;
  for (let t = 0; t < p.length - 1; t++) c += M[p[t]][p[t + 1]];
  return c;
}

// Local search on a path whose first and last nodes are fixed.
function localSearch(M, path, check) {
  const p = path.slice();
  const L = p.length;
  if (L <= 3) return p;
  const F = new Float64Array(L); // F[k] = cost of p[0..k] driven forwards
  const R = new Float64Array(L); // R[k] = same edges driven backwards
  const prefix = () => {
    for (let t = 0; t < L - 1; t++) {
      F[t + 1] = F[t] + M[p[t]][p[t + 1]];
      R[t + 1] = R[t] + M[p[t + 1]][p[t]];
    }
  };
  prefix();

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 5000) {
    improved = false;

    // 2-opt: reverse p[i..j]
    for (let i = 1; i < L - 2 && !improved; i++) {
      for (let j = i + 1; j <= L - 2; j++) {
        const a = p[i - 1], b = p[j + 1];
        const d = M[a][p[j]] + M[p[i]][b] - M[a][p[i]] - M[p[j]][b]
          + (R[j] - R[i]) - (F[j] - F[i]);
        if (d < -1e-7) {
          const before = check ? pathCost(M, p) : 0;
          reverse(p, i, j);
          if (check) assertDelta(before, pathCost(M, p), d, '2-opt');
          prefix();
          improved = true;
          break;
        }
      }
    }
    if (improved) continue;

    // or-opt: move a run of 1-3 stops elsewhere, optionally flipped
    outer:
    for (let len = 1; len <= 3; len++) {
      for (let i = 1; i + len - 1 <= L - 2; i++) {
        const k2 = i + len - 1;
        const a = p[i - 1], b = p[k2 + 1], s0 = p[i], sL = p[k2];
        const removeGain = M[a][b] - M[a][s0] - M[sL][b];
        const inFwd = F[k2] - F[i], inRev = R[k2] - R[i];
        for (let k = 0; k <= L - 2; k++) {
          if (k >= i - 1 && k <= k2) continue;
          const c = p[k], d = p[k + 1];
          const base = removeGain - M[c][d];
          const dF = base + M[c][s0] + M[sL][d];
          const dR = base + M[c][sL] + M[s0][d] + inRev - inFwd;
          if (dF < -1e-7 || dR < -1e-7) {
            const flip = dR < dF;
            const before = check ? pathCost(M, p) : 0;
            moveSegment(p, i, len, k, flip);
            if (check) assertDelta(before, pathCost(M, p), flip ? dR : dF, 'or-opt');
            prefix();
            improved = true;
            break outer;
          }
        }
      }
    }
  }
  return p;
}

function assertDelta(before, after, predicted, kind) {
  if (Math.abs((after - before) - predicted) > 1e-6 * Math.max(1, Math.abs(before))) {
    throw new Error(`${kind} delta mismatch: predicted ${predicted}, actual ${after - before}`);
  }
}

function reverse(p, i, j) {
  while (i < j) { const t = p[i]; p[i] = p[j]; p[j] = t; i++; j--; }
}

function moveSegment(p, i, len, k, flip) {
  const seg = p.splice(i, len);
  if (flip) seg.reverse();
  const ci = k < i ? k : k - len;
  p.splice(ci + 1, 0, ...seg);
}

// Random "double bridge" kick that keeps the fixed start and end in place.
function doubleBridge(p, rand) {
  const inner = p.slice(1, -1);
  const m = inner.length;
  if (m < 4) return p.slice();
  const cuts = new Set();
  while (cuts.size < 3) cuts.add(1 + Math.floor(rand() * (m - 1)));
  const [a, b, c] = [...cuts].sort((x, y) => x - y);
  const next = [...inner.slice(0, a), ...inner.slice(b, c), ...inner.slice(a, b), ...inner.slice(c)];
  return [p[0], ...next, p[p.length - 1]];
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
