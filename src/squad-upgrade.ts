import * as multisig from '@sqds/multisig'
import {
  Connection,
  PublicKey,
  TransactionMessage,
  Keypair,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  Transaction
} from '@solana/web3.js'
import { idlAddress } from '@coral-xyz/anchor/dist/cjs/idl.js'
import { sendTransaction } from './transaction-helpers.js'
import {
  findCanonicalPda,
  getSetDataInstruction,
  Compression,
  DataSource,
  Encoding,
  Format
} from '@solana-program/program-metadata'
import type { Address, TransactionSigner } from '@solana/kit'

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
  pdaTx
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
}) {
  const keypairObj = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypair)))

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
    keypairObj.publicKey
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

  // Add program-metadata IDL instruction if metadata buffer is provided
  if (metadataBufferObj) {
    const metadataIx = await createMetadataSetDataInstruction(
      programId,
      metadataBufferObj,
      vaultPda
    )
    instructions.push(metadataIx)
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

async function createMetadataSetDataInstruction(
  programId: PublicKey,
  bufferAddress: PublicKey,
  authority: PublicKey
): Promise<TransactionInstruction> {
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

  console.log('\n=== Program Metadata Info ===')
  console.log('Metadata PDA:', metadataPda)
  console.log('Buffer:', bufferAddr)
  console.log('Program Data:', programDataAddress.toString())

  // Vault signs via the multisig mechanism, not directly here
  const authoritySigner = {
    address: authorityAddr
  } as TransactionSigner

  const ix = getSetDataInstruction({
    metadata: metadataPda,
    authority: authoritySigner,
    buffer: bufferAddr,
    program: programAddr,
    programData: programDataAddress.toBase58() as Address,
    encoding: Encoding.Utf8,
    compression: Compression.Zlib,
    format: Format.Json,
    dataSource: DataSource.Direct
  })

  // Convert Kit instruction to web3.js TransactionInstruction
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts as { address: string; role: number }[]).map((acc) => ({
      pubkey: new PublicKey(acc.address),
      isSigner: (acc.role & 2) !== 0,
      isWritable: (acc.role & 1) !== 0
    })),
    data: Buffer.from(ix.data)
  })
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

async function parseVerificationTransaction(
  base64String: string
): Promise<Transaction> {
  // Decode base64 to buffer
  const buffer = Buffer.from(base64String, 'base64')

  // Parse into versioned transaction
  return Transaction.from(buffer)
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
