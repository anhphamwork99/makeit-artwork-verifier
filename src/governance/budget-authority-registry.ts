/** Shipped trust anchors for pre-activation measurement sample admission (ADR 0108).
 * IDs are read only from the independently approved, digest-verified proposal.
 * A new candidate needs a separately reviewed snapshot and registry entry.
 */
export interface BudgetSampleAuthorityAnchorV1 {
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly draftBytesDigest: string;
  readonly requiredCellId: string;
  readonly directory: string;
  readonly decisionDigest: string;
  readonly proposalDigest: string;
  readonly reviewDigest: string;
}

export const BUDGET_SAMPLE_AUTHORITY_REGISTRY: readonly BudgetSampleAuthorityAnchorV1[] = [
  {
    manifestId: '96efe5d3f3d67a911afa4d6085cff03236d6865b3c5370b2789adb7af1743e58',
    manifestFingerprint: '4217bb7ecdabf6bde9f702bb71a4ebd1ed87077cf88ba443c44053c6f0f0323c',
    draftBytesDigest: '4fb06edd4de0cd64e0c56f926342599b0d1c323811c06e3fcc0a89649b1cb173',
    requiredCellId: 'chromium-desktop-1440x1000',
    directory: 'governance/authorities/0102',
    decisionDigest: 'cc493be48621769f9aed2f41991b3aba3e904fddf38a5ce440a3dcd3cff1c802',
    proposalDigest: '75d90bcefdd19b364ee84dd06ec01166af8e7e21bf224c514c4c114c6aa95880',
    reviewDigest: '568ab1c2b322db833b8c8c1d52d7715a8ff60140a338ba8fe2d79ba9649f3f95',
  },
] as const;
