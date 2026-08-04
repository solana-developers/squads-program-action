import { describe, expect, it } from '@jest/globals'
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js'
import bs58 from 'bs58'
import {
  buildExportTransaction,
  parseVerificationTransaction
} from '../src/squad-upgrade.js'

function createWireTransaction(): Buffer {
  const payer = Keypair.generate().publicKey
  const transaction = new Transaction({
    feePayer: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58()
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1
    })
  )

  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false
  })
}

describe('parseVerificationTransaction', () => {
  it.each([
    ['base64', (bytes: Buffer) => bytes.toString('base64')],
    ['base58', (bytes: Buffer) => bs58.encode(bytes)]
  ])('parses a %s encoded transaction', async (_encoding, encode) => {
    const encoded = encode(createWireTransaction())

    const transaction = await parseVerificationTransaction(encoded)

    expect(transaction.instructions).toHaveLength(1)
    expect(transaction.instructions[0].programId).toEqual(
      SystemProgram.programId
    )
  })

  it('rejects invalid transaction data with a useful error', async () => {
    await expect(
      parseVerificationTransaction('not-a-transaction')
    ).rejects.toThrow(
      'Unable to decode PDA verification transaction as base64 or base58'
    )
  })
})

describe('buildExportTransaction', () => {
  const feePayer = Keypair.generate().publicKey
  const recentBlockhash = Keypair.generate().publicKey.toBase58()

  function createInstructions(count: number): TransactionInstruction[] {
    return Array.from({ length: count }, () =>
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1
      })
    )
  }

  it.each([
    ['base58', (encoded: string) => Buffer.from(bs58.decode(encoded))],
    ['base64', (encoded: string) => Buffer.from(encoded, 'base64')]
  ])(
    'exports all instructions in one %s encoded transaction',
    (encoding, decode) => {
      const instructions = createInstructions(3)

      const encoded = buildExportTransaction(
        instructions,
        feePayer,
        recentBlockhash,
        encoding as 'base58' | 'base64'
      )

      const transaction = Transaction.from(decode(encoded))
      expect(transaction.instructions).toHaveLength(3)
      expect(transaction.feePayer).toEqual(feePayer)
      expect(transaction.recentBlockhash).toEqual(recentBlockhash)
      expect(
        transaction.instructions.every((ix) =>
          ix.programId.equals(SystemProgram.programId)
        )
      ).toBe(true)
    }
  )

  it('defaults to base58 encoding', () => {
    const encoded = buildExportTransaction(
      createInstructions(1),
      feePayer,
      recentBlockhash
    )

    const transaction = Transaction.from(Buffer.from(bs58.decode(encoded)))
    expect(transaction.instructions).toHaveLength(1)
  })

  it('rejects transactions above the size limit with a useful error', () => {
    const oversized = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [{ pubkey: feePayer, isSigner: false, isWritable: true }],
      data: Buffer.alloc(1300)
    })

    expect(() =>
      buildExportTransaction([oversized], feePayer, recentBlockhash)
    ).toThrow('exceeds the 1232 byte transaction limit')
  })
})
