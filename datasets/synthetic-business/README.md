# Synthetic business v1

The schema, stable row IDs, distributions and anomaly rules live in the [dataset generator](../../benchmarks/generators/data.py). It uses a SHA-256 keyed generator with four-byte big-endian length prefixes. Each variant uses its own seed and physical map. Monetary storage is in integer USD cents and event timestamps use UTC. All monthly windows are half-open.

September and October deliberately differ in volume, item pricing and refund incidence. Each has a duplicate captured payment, an underpaid invoice and a refund that exceeds its captured payment. Those anomalies are part of the dataset and remain visible in receipts and reconciliation metrics.
