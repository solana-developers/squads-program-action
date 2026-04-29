export declare function main({ rpc, program, buffer, idlBuffer, metadataBuffer, multisig: multisigAddress, keypair, vaultIndex, priorityFee, pdaTx }: {
    rpc: string;
    program: string;
    buffer: string;
    idlBuffer: string;
    metadataBuffer?: string;
    multisig: string;
    keypair: string;
    vaultIndex: number;
    priorityFee: number;
    pdaTx?: string;
}): Promise<void>;
