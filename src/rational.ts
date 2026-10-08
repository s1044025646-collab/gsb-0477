function big(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  return BigInt(value);
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x === 0n ? 1n : x;
}

export class Rational {
  private constructor(
    readonly num: bigint,
    readonly den: bigint,
  ) {}

 static from(n: bigint | number | string, d: bigint | number | string = 1): Rational {
    const num = big(n);
    const den = big(d);
    if (den === 0n) throw new Error('零分母有理数');
    const sign = den < 0n ? -1n : 1n;
    const signedNum = num * sign;
    const signedDen = den * sign;
    const g = gcd(signedNum, signedDen);
    return new Rational(signedNum / g, signedDen / g);
  }

  static zero(): Rational {
    return new Rational(0n, 1n);
  }

  add(other: Rational): Rational {
    return Rational.from(
      this.num * other.den + other.num * this.den,
      this.den * other.den,
    );
  }

  sub(other: Rational): Rational {
    return Rational.from(
      this.num * other.den - other.num * this.den,
      this.den * other.den,
    );
  }

  mul(other: Rational): Rational {
    return Rational.from(this.num * other.num, this.den * other.den);
  }

  div(other: Rational): Rational {
    if (other.num === 0n) throw new Error('有理数除零');
    return Rational.from(this.num * other.den, this.den * other.num);
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  isNegative(): boolean {
    return this.num < 0n;
  }

  toDecimal(maxFractionDigits = 12): string {
    if (this.num === 0n) return '0';
    const negative = this.num < 0n;
    const a = negative ? -this.num : this.num;
    const intPart = a / this.den;
    let rem = a % this.den;
    let fraction = '';
    const seen = new Map<bigint, number>();
    while (rem !== 0n && fraction.length < maxFractionDigits) {
      if (seen.has(rem)) break;
      seen.set(rem, fraction.length);
      rem *= 10n;
      fraction += (rem / this.den).toString();
      rem %= this.den;
    }
    const sign = negative ? '-' : '';
    return fraction ? `${sign}${intPart}.${fraction}` : `${sign}${intPart}`;
  }

  toJSON(): { num: string; den: string; decimal: string } {
    return { num: this.num.toString(), den: this.den.toString(), decimal: this.toDecimal() };
  }
}
