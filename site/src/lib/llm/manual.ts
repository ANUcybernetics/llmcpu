// A compact RV32I reference for the system prompt (roughly 1.2k tokens). This
// is the "ISA manual" knob: with it the model at least knows the encoding.

export const RV32I_MANUAL = `RV32I QUICK REFERENCE
Every instruction is one 32-bit little-endian word (the 4 bytes at pc, least significant byte first). Bits [6:0] are the opcode; rd = bits [11:7]; funct3 = bits [14:12]; rs1 = bits [19:15]; rs2 = bits [24:20]; funct7 = bits [31:25]. Immediates are sign-extended.

opcode 0x37 lui   rd = imm[31:12] << 12
opcode 0x17 auipc rd = pc + (imm[31:12] << 12)
opcode 0x6f jal   rd = pc+4; pc = pc + imm   (J-imm from bits 31|19:12|20|30:21, in units of 2 bytes)
opcode 0x67 jalr  (funct3 0) rd = pc+4; pc = (rs1 + imm) & ~1
opcode 0x63 branch: compare rs1 with rs2, if true pc = pc + imm (B-imm from bits 31|7|30:25|11:8, units of 2 bytes) else pc+4
   funct3: 0 beq (==)  1 bne (!=)  4 blt (signed <)  5 bge (signed >=)  6 bltu (unsigned <)  7 bgeu (unsigned >=)
opcode 0x03 load: rd = memory[rs1 + imm] (imm = bits [31:20])
   funct3: 0 lb (1 byte, sign-extend)  1 lh (2 bytes, sign-extend)  2 lw (4 bytes)  4 lbu (1 byte, zero-extend)  5 lhu (2 bytes, zero-extend)
opcode 0x23 store: memory[rs1 + imm] = rs2 (S-imm from bits [31:25] and [11:7])
   funct3: 0 sb (low byte)  1 sh (low 2 bytes)  2 sw (4 bytes)
opcode 0x13 op-imm: rd = rs1 OP imm (imm = bits [31:20], shifts use bits [24:20] as the amount)
   funct3: 0 addi  1 slli  2 slti  3 sltiu  4 xori  5 srli (funct7 0x00) / srai (funct7 0x20)  6 ori  7 andi
opcode 0x33 op: rd = rs1 OP rs2
   funct3: 0 add (funct7 0x00) / sub (funct7 0x20)  1 sll  2 slt  3 sltu  4 xor  5 srl (0x00) / sra (0x20)  6 or  7 and
opcode 0x0f fence and 0x73 ecall/ebreak: no effect on this machine; just move to pc+4.

Registers: x0=zero (always 0), x1=ra (return address), x2=sp (stack pointer), x3=gp, x4=tp, x5-7=t0-t2, x8=s0/fp, x9=s1, x10-17=a0-a7 (arguments/results), x18-27=s2-s11, x28-31=t3-t6.
Common idioms: addi rd, zero, imm = load a constant; jalr zero, 0(ra) = return; jal zero, off = plain jump; lui + addi = build a 32-bit address; a store to 0x4000 prints a character; a store to 0x4004 halts.`;
