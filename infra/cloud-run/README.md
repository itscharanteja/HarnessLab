# Cloud Run release inputs

`fixture.example.json` is the sample inventory for the manifest renderer. It uses placeholder digests and endpoints. Run `make deploy-check ENV=fixture` to validate the shape locally.

The approved operator inventory supplies real image digests, distinct identities, secret versions, buckets, private networks and release metadata. Rendering produces five Cloud Run services, one isolated holdout Job, and the per-identity IAM assignment plan. Deploy and bind roles only from the authorized release environment. See the [operations runbook](../../docs/operations.md).
