import { describe, expect, it } from '@jest/globals'
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { parseVerificationTransaction } from '../src/squad-upgrade.js'

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
