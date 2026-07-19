export function mean(arr) {
  if (!Array.isArray(arr)) return null;
  let sum = 0;
  let n = 0;
  for (const v of arr) {
    if (v != null && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

export function stdev(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const m = mean(arr);
  if (m == null) return null;
  let sumSq = 0;
  let n = 0;
  for (const v of arr) {
    if (v != null && Number.isFinite(v)) {
      sumSq += (v - m) ** 2;
      n++;
    }
  }
  return n > 1 ? Math.sqrt(sumSq / (n - 1)) : null;
}

export function rollingWindow(arr, n) {
  if (!Array.isArray(arr)) return [];
  const clean = arr.filter((v) => v != null && Number.isFinite(v));
  return n > 0 ? clean.slice(-n) : [];
}

export function cumulative(arr) {
  if (!Array.isArray(arr)) return [];
  let acc = 0;
  return arr.map((v) => {
    acc += Number(v) || 0;
    return acc;
  });
}
