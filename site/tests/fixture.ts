// Hand-assembled RV32I program (clang -march=rv32i, llvm-objdump -M no-aliases
// --no-print-imm-hex), one line per instruction: address, raw word, canonical text.
export const FIXTURE = `
0 0x000045b7 lui	a1, 4
4 0x06100513 addi	a0, zero, 97
8 0x06600613 addi	a2, zero, 102
c 0x00a5a023 sw	a0, 0(a1)
10 0x00150513 addi	a0, a0, 1
14 0xfec51ce3 bne	a0, a2, 0xc
18 0xfff00513 addi	a0, zero, -1
1c 0x40455693 srai	a3, a0, 4
20 0x01c55713 srli	a4, a0, 28
24 0x00a037b3 sltu	a5, zero, a0
28 0x00052833 slt	a6, a0, zero
2c 0x00300893 addi	a7, zero, 3
30 0x411552b3 sra	t0, a0, a7
34 0x01189333 sll	t1, a7, a7
38 0x411003b3 sub	t2, zero, a7
3c 0xfff8ce13 xori	t3, a7, -1
40 0x01000eb7 lui	t4, 4096
44 0x00a00023 sb	a0, 0(zero)
48 0x00000f03 lb	t5, 0(zero)
4c 0x00004f83 lbu	t6, 0(zero)
50 0x01101423 sh	a7, 8(zero)
54 0x00801403 lh	s0, 8(zero)
58 0x00805483 lhu	s1, 8(zero)
5c 0x00802903 lw	s2, 8(zero)
60 0x014000ef jal	ra, 0x74
64 0x00000997 auipc	s3, 0
68 0x02a00a13 addi	s4, zero, 42
6c 0x0145a223 sw	s4, 4(a1)
70 0x0000006f jal	zero, 0x70
74 0x00700a93 addi	s5, zero, 7
78 0x00008067 jalr	zero, 0(ra)
`
  .trim()
  .split("\n")
  .map((line) => {
    const [addr, word, ...rest] = line.split(" ");
    return {
      addr: Number.parseInt(addr!, 16),
      word: Number.parseInt(word!, 16),
      text: rest.join(" "),
    };
  });

export const fixtureBytes = (): Uint8Array => {
  const bytes = new Uint8Array(FIXTURE.length * 4);
  const view = new DataView(bytes.buffer);
  for (const { addr, word } of FIXTURE) view.setUint32(addr, word, true);
  return bytes;
};
