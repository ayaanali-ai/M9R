# AWARE protocol

A standalone public specification package for the M9R web-coordination envelope. The JSON Schema in `schema/aware-web-protocol-v0.schema.json` is exported from the validated in-repo protocol package; the wire shape is unchanged by this export.

- Protocol schemas and reference code: Apache-2.0 (see `LICENSE-APACHE`).
- Human-readable specification and examples: CC BY 4.0 (see `LICENSE-CC-BY-4.0`).
- The schema currently retains the `m9r-web/0` protocol identifier so existing implementations remain conformant. A future AWARE wire identifier must be versioned explicitly rather than silently changing this file.

Implementation status: this is a protocol specification and an early reference implementation. The ledger enforces its schema, attribution, membership, quiet-until-invited, disclosure, and spend-cap rules only on paths that call the ledger; it is not currently wired to every M9R execution path. In particular, do not describe AWARE as governing every browser, shell, or file action until those paths are integrated.

This directory is a publication staging tree. It is intentionally separate from the BUSL-licensed application root, but it is not a hosted Git repository and this script does not create or push a remote.
