import * as multisig from '@sqds/multisig'
import {
  Connection,
  PublicKey,
  TransactionMessage,
  Keypair,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  Transaction,
  SystemProgram
} from '@solana/web3.js'
import { idlAddress } from '@coral-xyz/anchor/dist/cjs/idl.js'
import bs58 from 'bs58'
import { sendTransaction } from './transaction-helpers.js'
import {
  ACCOUNT_HEADER_LENGTH,
  findCanonicalPda,
  getAllocateInstruction,
  getExtendInstruction,
  getInitializeInstruction,
  getSetDataInstruction,
  getWriteInstruction,
  Compression,
  DataSource,
  Encoding,
  Format
} from '@solana-program/program-metadata'
import type { Address, TransactionSigner } from '@solana/kit'

const REALLOC_LIMIT = 10240

const MAX_TRANSACTION_BYTES = 1232

const BPF_UPGRADE_LOADER_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111'
)

export async function main({
  rpc,
  program,
  buffer,
  idlBuffer,
  metadataBuffer,
  multisig: multisigAddress,
  keypair,
  vaultIndex,
  priorityFee,
  pdaTx,
  exportOnly,
  exportEncoding
}: {
  rpc: string
  program: string
  buffer: string
  idlBuffer: string
  metadataBuffer?: string
  multisig: string
  keypair: string
  vaultIndex: number
  priorityFee: number
  pdaTx?: string
  exportOnly?: boolean
  exportEncoding?: 'base58' | 'base64'
}): Promise<string | undefined> {
  if (!exportOnly && !keypair) {
    throw new Error('keypair is required unless export is true')
  }

  const keypairObj = keypair
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypair)))
    : undefined

  const connection = new Connection(rpc)

  const multisigPda = new PublicKey(multisigAddress)
  const programId = new PublicKey(program)
  const programBuffer = new PublicKey(buffer)
  let idlBufferObj
  let metadataBufferObj

  if (idlBuffer != null && idlBuffer !== '') {
    idlBufferObj = new PublicKey(idlBuffer)
  }

  if (metadataBuffer != null && metadataBuffer !== '') {
    metadataBufferObj = new PublicKey(metadataBuffer)
  }

  if (idlBufferObj && metadataBufferObj) {
    throw new Error(
      'Cannot use both idl-buffer and metadata-buffer. ' +
        'Use idl-buffer for Anchor IDL or metadata-buffer for program-metadata.'
    )
  }

  // Get vault PDA (authority)
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: vaultIndex
  })

  console.log('\n=== Setup Info ===')
  console.log('Multisig:', multisigPda.toString())
  console.log('Vault:', vaultPda.toString())
  console.log('Program:', programId.toString())
  console.log('Program Buffer:', programBuffer.toString())
  if (idlBufferObj) console.log('Anchor IDL Buffer:', idlBufferObj.toString())
  if (metadataBufferObj)
    console.log('Metadata Buffer:', metadataBufferObj.toString())
  console.log('Extracted PDA transaction:', pdaTx?.toString())

  // Get current and new program sizes
  const programAccount = await getAccountInfoWithRetry(connection, programId)
  const bufferAccount = await getAccountInfoWithRetry(connection, programBuffer)

  if (!programAccount || !bufferAccount) {
    throw new Error('Could not fetch program or buffer account')
  }

  // Create both upgrade instructions
  const programUpgradeIx = await createProgramUpgradeInstruction(
    programId,
    programBuffer,
    vaultPda,
    keypairObj?.publicKey ?? vaultPda
  )

  // Build transaction message with all instructions
  let instructions = []
  let memo = 'Program upgrade'

  // Add Anchor IDL upgrade instruction if IDL buffer is provided
  if (idlBufferObj) {
    const idlUpgradeIx = await createIdlUpgradeInstruction(
      programId,
      idlBufferObj,
      vaultPda
    )
    instructions.push(idlUpgradeIx)
    memo += ' with Anchor IDL update'
  }

  // Add program-metadata IDL instruction(s) if metadata buffer is provided
  if (metadataBufferObj) {
    const metadataIxs = await createMetadataInstructions(
      connection,
      programId,
      metadataBufferObj,
      vaultPda
    )
    instructions.push(...metadataIxs)
    memo += ' with program-metadata IDL update'
  }

  // Add program upgrade instruction
  instructions.push(programUpgradeIx)

  // Add verification instruction if provided
  if (pdaTx) {
    const verificationTx = await parseVerificationTransaction(pdaTx)
    if (verificationTx.instructions.length > 0) {
      console.log('Adding verification instruction')
      instructions = [verificationTx.instructions[1], ...instructions]
      memo += ' and PDA verification'
    }
  }

  if (exportOnly) {
    const encoded = buildExportTransaction(
      instructions,
      vaultPda,
      (await connection.getLatestBlockhash()).blockhash,
      exportEncoding
    )

    console.log('\n=== Exported Combined Transaction ===')
    console.log(
      'Import this transaction into the Squads transaction builder to create the upgrade proposal:'
    )
    console.log(encoded)
    return encoded
  }

  if (!keypairObj) {
    throw new Error('keypair is required unless export is true')
  }

  const message = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions
  })

  // Get next transaction index
  const multisigInfo = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  )

  const currentTransactionIndex = Number(multisigInfo.transactionIndex)
  const newTransactionIndex = BigInt(currentTransactionIndex + 1)

  try {
    console.log('\n=== Creating Upgrade Transaction ===')

    // Create vault transaction instruction
    const createVaultTxIx = await multisig.instructions.vaultTransactionCreate({
      multisigPda,
      transactionIndex: newTransactionIndex,
      creator: keypairObj.publicKey,
      vaultIndex: vaultIndex,
      ephemeralSigners: 0,
      transactionMessage: message,
      memo
    })

    // Create transaction and add compute budget
    const tx = new Transaction()
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    tx.add(createVaultTxIx)

    // Send transaction
    const createVaultSignature = await sendTransaction(
      connection,
      tx,
      [keypairObj],
      priorityFee
    )

    console.log('Transaction Created - Signature:', createVaultSignature)

    // Create proposal instruction
    console.log('\n=== Creating Proposal ===')
    console.log('\nWith transaction index:', newTransactionIndex)
    console.log('\nPlease approve in Squads UI: https://v4.squads.so/')
  } catch (error) {
    console.error('\n=== Error ===')
    console.error('Error details:', error)
    process.exit(1)
  }
}

function kitIxToWeb3(ix: {
  programAddress: string
  accounts: readonly unknown[]
  data: ArrayLike<number>
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts as { address: string; role: number }[]).map((acc) => ({
      pubkey: new PublicKey(acc.address),
      isSigner: (acc.role & 2) !== 0,
      isWritable: (acc.role & 1) !== 0
    })),
    data: Buffer.from(ix.data as unknown as Uint8Array)
  })
}

async function createMetadataInstructions(
  connection: Connection,
  programId: PublicKey,
  bufferAddress: PublicKey,
  authority: PublicKey
): Promise<TransactionInstruction[]> {
  const programAddr = programId.toBase58() as Address
  const bufferAddr = bufferAddress.toBase58() as Address
  const authorityAddr = authority.toBase58() as Address

  const [metadataPda] = await findCanonicalPda({
    program: programAddr,
    seed: 'idl'
  })

  const [programDataAddress] = await PublicKey.findProgramAddress(
    [programId.toBuffer()],
    BPF_UPGRADE_LOADER_ID
  )

  const metadataPdaPubkey = new PublicKey(metadataPda)
  const programDataAddr = programDataAddress.toBase58() as Address

  console.log('\n=== Program Metadata Info ===')
  console.log('Metadata PDA:', metadataPda)
  console.log('Buffer:', bufferAddr)
  console.log('Program Data:', programDataAddress.toString())

  const authoritySigner = {
    address: authorityAddr
  } as TransactionSigner

  const metadataAccount = await connection.getAccountInfo(
    metadataPdaPubkey,
    'confirmed'
  )

  if (metadataAccount) {
    console.log('Metadata account exists, updating via SetData')

    const bufferAccount = await connection.getAccountInfo(
      bufferAddress,
      'confirmed'
    )
    if (!bufferAccount) {
      throw new Error(
        `Metadata buffer account ${bufferAddress.toString()} not found. ` +
          'Make sure the buffer was created and is on the correct cluster.'
      )
    }

    const newDataLength =
      bufferAccount.data.length > ACCOUNT_HEADER_LENGTH
        ? bufferAccount.data.length - ACCOUNT_HEADER_LENGTH
        : bufferAccount.data.length
    const currentDataLength =
      metadataAccount.data.length > ACCOUNT_HEADER_LENGTH
        ? metadataAccount.data.length - ACCOUNT_HEADER_LENGTH
        : metadataAccount.data.length
    const sizeDifference = newDataLength - currentDataLength

    console.log(
      `Current metadata data: ${currentDataLength} bytes, ` +
        `new buffer data: ${newDataLength} bytes, ` +
        `size difference: ${sizeDifference} bytes`
    )

    const updateInstructions: TransactionInstruction[] = []

    if (sizeDifference > 0) {
      const extraRent =
        await connection.getMinimumBalanceForRentExemption(sizeDifference)
      console.log(`Transferring ${extraRent} extra lamports for size increase`)
      updateInstructions.push(
        SystemProgram.transfer({
          fromPubkey: authority,
          toPubkey: metadataPdaPubkey,
          lamports: extraRent
        })
      )

      if (sizeDifference > REALLOC_LIMIT) {
        let remaining = sizeDifference
        while (remaining > 0) {
          const chunk = Math.min(remaining, REALLOC_LIMIT)
          updateInstructions.push(
            kitIxToWeb3(
              getExtendInstruction({
                account: metadataPda,
                authority: authoritySigner,
                program: programAddr,
                programData: programDataAddr,
                length: chunk
              })
            )
          )
          remaining -= chunk
        }
      }
    }

    updateInstructions.push(
      kitIxToWeb3(
        getSetDataInstruction({
          metadata: metadataPda,
          authority: authoritySigner,
          buffer: bufferAddr,
          program: programAddr,
          programData: programDataAddr,
          encoding: Encoding.Utf8,
          compression: Compression.Zlib,
          format: Format.Json,
          dataSource: DataSource.Direct
        })
      )
    )

    return updateInstructions
  }

  // Metadata account does not exist — follow the SDK's create flow:
  // Transfer -> Allocate -> Extend (if needed) -> Write -> Initialize
  console.log('Metadata account does not exist, adding init instructions')

  const bufferAccount = await connection.getAccountInfo(
    bufferAddress,
    'confirmed'
  )
  if (!bufferAccount) {
    throw new Error(
      `Metadata buffer account ${bufferAddress.toString()} not found. ` +
        'Make sure the buffer was created and is on the correct cluster.'
    )
  }

  const dataLength =
    bufferAccount.data.length > ACCOUNT_HEADER_LENGTH
      ? bufferAccount.data.length - ACCOUNT_HEADER_LENGTH
      : bufferAccount.data.length
  const accountSize = BigInt(ACCOUNT_HEADER_LENGTH) + BigInt(dataLength)
  const rentLamports = await connection.getMinimumBalanceForRentExemption(
    Number(accountSize)
  )

  console.log(
    `Buffer data: ${bufferAccount.data.length} bytes, ` +
      `data portion: ${dataLength} bytes, ` +
      `target account size: ${accountSize} bytes, ` +
      `rent: ${rentLamports} lamports`
  )

  const instructions: TransactionInstruction[] = []

  // 1. Fund the metadata PDA with rent
  instructions.push(
    SystemProgram.transfer({
      fromPubkey: authority,
      toPubkey: metadataPdaPubkey,
      lamports: rentLamports
    })
  )

  // 2. Allocate the PDA as a program-metadata buffer
  instructions.push(
    kitIxToWeb3(
      getAllocateInstruction({
        buffer: metadataPda,
        authority: authoritySigner,
        program: programAddr,
        programData: programDataAddr,
        seed: 'idl'
      })
    )
  )

  // 3. Extend if data exceeds the realloc limit (10KB per instruction)
  if (dataLength > REALLOC_LIMIT) {
    let remaining = dataLength
    while (remaining > 0) {
      const chunk = Math.min(remaining, REALLOC_LIMIT)
      instructions.push(
        kitIxToWeb3(
          getExtendInstruction({
            account: metadataPda,
            authority: authoritySigner,
            program: programAddr,
            programData: programDataAddr,
            length: chunk
          })
        )
      )
      remaining -= chunk
    }
  }

  // 4. Write data from the source buffer into the PDA buffer
  instructions.push(
    kitIxToWeb3(
      getWriteInstruction({
        buffer: metadataPda,
        authority: authoritySigner,
        sourceBuffer: bufferAddr,
        offset: 0
      })
    )
  )

  // 5. Initialize — converts the pre-allocated buffer into a metadata account
  instructions.push(
    kitIxToWeb3(
      getInitializeInstruction({
        metadata: metadataPda,
        authority: authoritySigner,
        program: programAddr,
        programData: programDataAddr,
        seed: 'idl',
        encoding: Encoding.Utf8,
        compression: Compression.Zlib,
        format: Format.Json,
        dataSource: DataSource.Direct
      })
    )
  )

  return instructions
}

async function createIdlUpgradeInstruction(
  programId: PublicKey,
  bufferAddress: PublicKey,
  upgradeAuthority: PublicKey
): Promise<TransactionInstruction> {
  const idlAddr = await idlAddress(programId)

  console.log('\n=== IDL Info ===')
  console.log('IDL Address:', idlAddr.toString())
  console.log('Buffer:', bufferAddress.toString())

  // Create instruction data: [40, f4, bc, 78, a7, e9, 69, 0a, 03]
  const data = Buffer.from([
    0x40, 0xf4, 0xbc, 0x78, 0xa7, 0xe9, 0x69, 0x0a, 0x03
  ])

  return new TransactionInstruction({
    keys: [
      { pubkey: bufferAddress, isWritable: true, isSigner: false },
      { pubkey: idlAddr, isWritable: true, isSigner: false },
      { pubkey: upgradeAuthority, isWritable: true, isSigner: true }
    ],
    programId,
    data
  })
}

async function createProgramUpgradeInstruction(
  programId: PublicKey,
  bufferAddress: PublicKey,
  upgradeAuthority: PublicKey,
  spillAddress: PublicKey
): Promise<TransactionInstruction> {
  const [programDataAddress] = await PublicKey.findProgramAddress(
    [programId.toBuffer()],
    BPF_UPGRADE_LOADER_ID
  )

  return new TransactionInstruction({
    keys: [
      { pubkey: programDataAddress, isWritable: true, isSigner: false },
      { pubkey: programId, isWritable: true, isSigner: false },
      { pubkey: bufferAddress, isWritable: true, isSigner: false },
      { pubkey: spillAddress, isWritable: true, isSigner: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isWritable: false, isSigner: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isWritable: false, isSigner: false },
      { pubkey: upgradeAuthority, isWritable: false, isSigner: true }
    ],
    programId: BPF_UPGRADE_LOADER_ID,
    data: Buffer.from([3, 0, 0, 0])
  })
}

export function buildExportTransaction(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  recentBlockhash: string,
  encoding: 'base58' | 'base64' = 'base58'
): string {
  const transaction = new Transaction()
  transaction.feePayer = feePayer
  transaction.recentBlockhash = recentBlockhash
  transaction.add(...instructions)

  let wire: Buffer
  try {
    wire = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    })
  } catch (error) {
    throw new Error(
      `Combined transaction exceeds the ${MAX_TRANSACTION_BYTES} byte ` +
        'transaction limit. Export the verify, IDL, and upgrade ' +
        'transactions separately instead. Serialization error: ' +
        (error instanceof Error ? error.message : String(error))
    )
  }

  return encoding === 'base64'
    ? Buffer.from(wire).toString('base64')
    : bs58.encode(wire)
}

export async function parseVerificationTransaction(
  encodedTransaction: string
): Promise<Transaction> {
  const value = encodedTransaction.trim()

  try {
    return Transaction.from(Buffer.from(value, 'base64'))
  } catch (base64Error) {
    try {
      return Transaction.from(Buffer.from(bs58.decode(value)))
    } catch (base58Error) {
      const base64Message =
        base64Error instanceof Error ? base64Error.message : String(base64Error)
      const base58Message =
        base58Error instanceof Error ? base58Error.message : String(base58Error)

      throw new Error(
        'Unable to decode PDA verification transaction as base64 or base58. ' +
          `Base64 error: ${base64Message}. Base58 error: ${base58Message}.`
      )
    }
  }
}

async function getAccountInfoWithRetry(
  connection: Connection,
  pubkey: PublicKey,
  retries = 5,
  delay = 1000
) {
  for (let i = 0; i < retries; i++) {
    try {
      const account = await connection.getAccountInfo(pubkey)
      return account
    } catch (error) {
      if (i === retries - 1) {
        throw new Error(
          `Failed to get account info for ${pubkey.toString()} after ${retries} attempts: ${error}`
        )
      }
      console.log(
        `Retry ${i + 1}/${retries} getting account info for ${pubkey.toString()}`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

// Remove this block if not needed
// if (require.main === module) {
//   main({
//     rpc: process.argv[2],
//     program: process.argv[3],
//     buffer: process.argv[4],
//     idlBuffer: process.argv[5],
//     multisig: process.argv[6],
//     keypair: process.argv[7],
//     pdaTx: process.argv[8]
//   }).catch(console.error);
// }
