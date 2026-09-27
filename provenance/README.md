# Extraction provenance

`source-manifest.sha256` records the SHA-256 digest and skill-relative path of
the 414 files approved in the original private extraction snapshot. It contains
no absolute paths, credentials, evidence records, or Git history. The transfer
guard uses it to distinguish the reviewed baseline from intentional standalone
repository additions and edits.
