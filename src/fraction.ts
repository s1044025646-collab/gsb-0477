/** 精确有理数：所有退化判定与核心汇总均以有理数进行，显示小数不参与判定。 */
export interface Frac { n: bigint; d: bigint; }

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a === 0n ? 1n : a;
}

export function frac(n: bigint, d: bigint = 1n): Frac {
  if (d === 0n) throw new Error("denominator zero");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
export const fadd = (a: Frac, b: Frac): Frac => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const fsub = (a: Frac, b: Frac): Frac => frac(a.n * b.d - b.n * a.d, a.d * b.d);
export const fmul = (a: Frac, b: Frac): Frac => frac(a.n * b.n, a.d * b.d);
export const fdiv = (a: Frac, b: Frac): Frac => frac(a.n * b.d, a.d * b.n);
export const fisZero = (a: Frac): boolean => a.n === 0n;
export const fnum = (a: Frac): number => Number(a.n) / Number(a.d);
export const fint = (v: bigint | number): Frac => frac(BigInt(v), 1n);
