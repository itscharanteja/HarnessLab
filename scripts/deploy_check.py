"""Validate and render a deployment plan. This command only reads cloud resources."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from harnesslab_contracts.validate import accepts

ROLES = ("api", "dispatcher", "runner", "evaluator", "optimizer", "holdout")
PORTS = {"api": 4000, "dispatcher": 4001, "runner": 8000, "evaluator": 8000, "optimizer": 8000}
ACCESS = {
    "api": {
        "CONTROL_API_DSN": "api-db",
        "CONTROL_PROMOTER_DSN": "promoter-db",
        "REDIS_URL": "redis",
        "HL_PROXY_TOKEN": "proxy",
        "HL_SESSION_SIGNING_KEY": "session",
        "HL_API_DISPATCH_TOKEN": "api-dispatch",
    },
    "dispatcher": {
        "CONTROL_DISPATCHER_DSN": "dispatcher-db",
        "REDIS_URL": "redis",
        "HL_API_DISPATCH_TOKEN": "api-dispatch",
        "HL_RUNNER_TOKEN": "runner-token",
        "HL_EVALUATOR_TOKEN": "evaluator-token",
        "HL_OPTIMIZER_TOKEN": "optimizer-token",
        "HL_WORKER_CHECKPOINT_TOKEN": "worker-checkpoint",
        "HL_OPTIMIZER_CHECKPOINT_TOKEN": "optimizer-checkpoint",
        "HL_OPS_TOKEN": "ops",
    },
    "runner": {"HL_DISPATCHER_TOKEN": "runner-token", "HL_CHECKPOINT_TOKEN": "worker-checkpoint"},
    "evaluator": {"HL_DISPATCHER_TOKEN": "evaluator-token"},
    "optimizer": {
        "HL_DISPATCHER_TOKEN": "optimizer-token",
        "HL_CHECKPOINT_TOKEN": "optimizer-checkpoint",
    },
    "holdout": {
        "HL_HOLDOUT_API_KEY": "holdout-provider",
        "HL_HOLDOUT_LEDGER_DSN": "holdout-ledger",
    },
}
RUNTIME_MAPS = {
    "runner": {"dev": "sandbox-dev", "validation": "sandbox-validation"},
    "holdout": {"holdout": "sandbox-holdout"},
}
MOUNTS = {
    "dispatcher": {"prompts": "/artifacts", "profiles": "/profiles"},
    "evaluator": {"references": "/artifacts"},
    "holdout": {"holdout": "/holdout", "reports": "/reports"},
}
INVOKERS = {
    "dispatcher": ["api", "runner", "optimizer"],
    "runner": ["dispatcher"],
    "evaluator": ["dispatcher"],
    "optimizer": ["dispatcher"],
}


def need(condition, code):
    if not condition:
        raise ValueError(code)


def origin(value):
    url = urlsplit(value)
    return (
        url.scheme == "https"
        and url.netloc
        and url.hostname
        and url.hostname == url.netloc
        and url.path == ""
        and not url.query
        and not url.fragment
    )


def validate(config, environment):
    need(config["environment"] == environment, "environment_mismatch")
    need(re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", config["project"]), "invalid_project")
    need(re.fullmatch(r"[0-9]{6,16}", config["project_number"]), "invalid_project_number")
    need(re.fullmatch(r"[a-z]+-[a-z0-9]+[0-9]", config["region"]), "invalid_region")
    need(origin(config["public_origin"]), "invalid_public_origin")
    need(
        config["supabase_issuer"].endswith("/auth/v1")
        and origin(config["supabase_issuer"].removesuffix("/auth/v1")),
        "invalid_supabase_issuer",
    )
    need(
        config["operator_subjects"]
        and all(accepts("Uuid", x) for x in config["operator_subjects"]),
        "missing_operator_allowlist",
    )
    services, buckets, secrets = config["services"], config["buckets"], config["secrets"]
    need(set(services) == set(ROLES), "invalid_service_inventory")
    for role, service in services.items():
        need(
            re.fullmatch(
                r"[a-z0-9-]+-docker\.pkg\.dev/[a-z0-9_./-]+@sha256:[0-9a-f]{64}", service["image"]
            ),
            f"unpinned_{role}_image",
        )
        need(
            re.fullmatch(
                r"[a-z0-9-]+@" + re.escape(config["project"]) + r"\.iam\.gserviceaccount\.com",
                service["account"],
            ),
            f"invalid_{role}_identity",
        )
        if role != "holdout":
            need(
                origin(service["url"]) and service["url"].endswith(".run.app"),
                f"invalid_{role}_audience",
            )
    for field in ("image", "account"):
        need(
            len({service[field] for service in services.values()}) == len(ROLES), f"shared_{field}"
        )
    need(len({services[role]["url"] for role in PORTS}) == len(PORTS), "shared_service_audience")
    need(
        set(buckets) == {key for mount in MOUNTS.values() for key in mount}
        and all(re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,61}", x) for x in buckets.values())
        and len(set(buckets.values())) == len(buckets),
        "artifact_bucket_isolation",
    )
    network = config["network"]
    need(
        all(
            re.fullmatch(r"[a-z][a-z0-9-]{0,62}", network[key])
            for key in ("online", "subnet", "holdout", "holdout_subnet")
        )
        and network["online"] != network["holdout"],
        "holdout_network_isolation",
    )
    release, holdout = config["release"], config["holdout"]
    need(
        release["mode"] in {"fixture", "live"}
        and type(release["public_runs"]) is bool
        and type(release["max_spend_microusd"]) is int
        and 0 <= release["max_spend_microusd"] <= 9007199254740991
        and (release["mode"] == "live") == (release["max_spend_microusd"] > 0),
        "invalid_release_budget",
    )
    need(
        all(accepts("Digest", release[k]) for k in ("dev_digest", "validation_digest")),
        "missing_release_digests",
    )
    need(
        accepts("Digest", holdout["manifest_digest"])
        and holdout["manifest_digest"] not in {release["dev_digest"], release["validation_digest"]}
        and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", holdout["release_id"])
        and type(holdout["spend_cap_microusd"]) is int
        and 0 < holdout["spend_cap_microusd"] <= 9007199254740991,
        "invalid_holdout_nomination",
    )
    need(
        all(
            re.fullmatch(r"[a-z][a-z0-9_]{1,62}", holdout[k])
            for k in ("sandbox_database", "ledger_database")
        )
        and holdout["sandbox_database"] != holdout["ledger_database"],
        "holdout_ledger_isolation",
    )
    required = {secret for access in ACCESS.values() for secret in access.values()} | {
        secret for mount in RUNTIME_MAPS.values() for secret in mount.values()
    }
    if release["mode"] == "live":
        required |= {"runner-provider", "optimizer-provider"}
    need(
        required <= set(secrets)
        and all(re.fullmatch(r"[A-Za-z0-9_-]+:[1-9][0-9]*", x) for x in secrets.values())
        and len({x.split(":")[0] for x in secrets.values()}) == len(secrets),
        "missing_or_unpinned_secret_versions",
    )


def service_env(role, config):
    release = config["release"]
    urls = {key: service["url"] for key, service in config["services"].items() if key in PORTS}
    shared = {"HL_MODE": release["mode"], "HL_CLOUD_RUN_IDENTITY": "1"}
    if role == "api":
        return {
            **shared,
            "HL_PUBLIC_ORIGIN": config["public_origin"],
            "HL_AUTH_MODE": "supabase",
            "HL_SUPABASE_ISSUER": config["supabase_issuer"],
            "HL_SUPABASE_AUDIENCE": "authenticated",
            "HL_OPERATOR_SUBJECTS": ",".join(config["operator_subjects"]),
            "HL_DISPATCHER_INTERNAL_URL": urls["dispatcher"],
            "HL_PUBLIC_RUNS": str(int(release["public_runs"])),
        }
    if role == "dispatcher":
        return {
            **shared,
            "RUNNER_URL": urls["runner"],
            "EVALUATOR_URL": urls["evaluator"],
            "OPTIMIZER_URL": urls["optimizer"],
            "HL_DISPATCHER_ARTIFACT_DIR": "/artifacts",
            "HL_PUBLIC_RUNS": str(int(release["public_runs"])),
            "HL_WORKER_PROFILE_FILE": "/profiles/worker.json",
            "HL_OPTIMIZER_PROFILE_FILE": "/profiles/optimizer.json",
            "HL_PRICE_PROFILE_FILE": "/profiles/price.json",
            "HL_MAX_EXPERIMENT_MICRO_USD": str(release["max_spend_microusd"]),
            "HL_DEV_MANIFEST_DIGEST": release["dev_digest"],
            "HL_VALIDATION_MANIFEST_DIGEST": release["validation_digest"],
        }
    if role in {"runner", "optimizer"}:
        env = {**shared, "HL_CHECKPOINT_URL": urls["dispatcher"] + "/internal/v1/checkpoint"}
        if role == "runner":
            env |= {
                f"HL_SANDBOX_{split.upper()}_RUNTIME_MAP_FILE": f"/runtime-{split}/runtime.json"
                for split in RUNTIME_MAPS[role]
            }
        return env
    if role == "evaluator":
        return {"HL_EVALUATOR_ARTIFACT_DIR": "/artifacts"}
    holdout = config["holdout"]
    return {
        "HL_HOLDOUT_SANDBOX_DATABASE": holdout["sandbox_database"],
        "HL_HOLDOUT_LEDGER_DATABASE": holdout["ledger_database"],
        "HL_HOLDOUT_REPORT_DIR": "/reports",
        "HL_HOLDOUT_IMAGE_DIGEST": config["services"]["holdout"]["image"].split("@")[1],
    }


def manifests(config):
    output, bindings = {}, {}
    for role, service in config["services"].items():
        access = dict(ACCESS[role])
        if config["release"]["mode"] == "live" and role in {"runner", "optimizer"}:
            access["OPENAI_API_KEY"] = role + "-provider"
        env = [{"name": name, "value": value} for name, value in service_env(role, config).items()]
        secret_access = set(access.values())
        for name, reference in access.items():
            secret, version = config["secrets"][reference].split(":")
            env.append(
                {"name": name, "valueFrom": {"secretKeyRef": {"name": secret, "key": version}}}
            )
        mounts, volumes = [], []
        for key, path in MOUNTS.get(role, {}).items():
            mounts.append({"name": key, "mountPath": path})
            attrs = {"bucketName": config["buckets"][key]}
            if role == "holdout":
                attrs["mountOptions"] = "uid=65534,gid=65534,dir-mode=0700,file-mode=0600"
            volumes.append(
                {
                    "name": key,
                    "csi": {
                        "driver": "gcsfuse.run.googleapis.com",
                        "readOnly": key != "reports",
                        "volumeAttributes": attrs,
                    },
                }
            )
        for split, reference in RUNTIME_MAPS.get(role, {}).items():
            secret_access.add(reference)
            name = "runtime-" + split
            secret, version = config["secrets"][reference].split(":")
            mounts.append({"name": name, "mountPath": "/" + name})
            volumes.append(
                {
                    "name": name,
                    "secret": {
                        "secretName": secret,
                        "items": [{"key": version, "path": "runtime.json"}],
                    },
                }
            )
        container = {"image": service["image"], "env": env}
        if mounts:
            container["volumeMounts"] = mounts
        execution = {"serviceAccountName": service["account"], "containers": [container]}
        if volumes:
            execution["volumes"] = volumes
        metadata = {
            "name": f"harnesslab-{role}",
            "namespace": config["project_number"],
            "labels": {"cloud.googleapis.com/location": config["region"]},
        }
        net = config["network"]
        annotations = {
            "run.googleapis.com/execution-environment": "gen2",
            "run.googleapis.com/vpc-access-egress": "private-ranges-only",
            "run.googleapis.com/network-interfaces": json.dumps(
                [
                    {"network": net["holdout"], "subnetwork": net["holdout_subnet"]}
                    if role == "holdout"
                    else {"network": net["online"], "subnetwork": net["subnet"]}
                ],
                separators=(",", ":"),
            ),
        }
        if role == "holdout":
            holdout = config["holdout"]
            container["args"] = [
                "--mode",
                "release",
                "--baseline",
                "/holdout/baseline.yaml",
                "--candidate",
                "/holdout/candidate.yaml",
                "--manifest-digest",
                holdout["manifest_digest"],
                "--release-id",
                holdout["release_id"],
                "--spend-cap",
                str(holdout["spend_cap_microusd"]),
                "--bundle",
                "/holdout/bundle",
                "--runtime-map",
                "/runtime-holdout/runtime.json",
                "--work-dir",
                "/tmp/harnesslab-holdout",
                "--worker-profile",
                "/holdout/worker.json",
                "--price-profile",
                "/holdout/price.json",
            ]
            execution |= {"timeoutSeconds": 18000, "maxRetries": 0}
            output[role] = {
                "apiVersion": "run.googleapis.com/v1",
                "kind": "Job",
                "metadata": metadata,
                "spec": {
                    "template": {
                        "metadata": {"annotations": annotations},
                        "spec": {"taskCount": 1, "parallelism": 1, "template": {"spec": execution}},
                    }
                },
            }
        else:
            metadata["annotations"] = {"run.googleapis.com/ingress": "all"}
            if role == "api":
                metadata["annotations"]["run.googleapis.com/invoker-iam-disabled"] = "true"
            if role == "dispatcher":
                metadata["annotations"] |= {
                    "run.googleapis.com/minScale": "1",
                    "run.googleapis.com/maxScale": "1",
                }
                annotations["run.googleapis.com/cpu-throttling"] = "false"
            port = PORTS[role]
            container["ports"] = [{"containerPort": port}]
            container["startupProbe"] = {
                "httpGet": {"path": "/readyz", "port": port},
                "periodSeconds": 3,
                "timeoutSeconds": 2,
                "failureThreshold": 20,
            }
            if role in {"runner", "evaluator", "optimizer"}:
                container["command"] = ["uvicorn"]
                module = {"runner": "runner", "evaluator": "eval", "optimizer": "opt"}[role]
                container["args"] = [f"harnesslab_{module}.http:app", "--host", "0.0.0.0"]
            execution |= {
                "containerConcurrency": 8 if role in {"api", "dispatcher"} else 1,
                "timeoutSeconds": 110 if role == "runner" else 30,
            }
            output[role] = {
                "apiVersion": "serving.knative.dev/v1",
                "kind": "Service",
                "metadata": metadata,
                "spec": {"template": {"metadata": {"annotations": annotations}, "spec": execution}},
            }
        bindings[role] = {
            "account": service["account"],
            "invokers": [
                config["services"][caller]["account"] for caller in INVOKERS.get(role, [])
            ],
            "secret_accessor": sorted(
                config["secrets"][key].split(":")[0] for key in secret_access
            ),
            "artifact_reader": [
                config["buckets"][key] for key in MOUNTS.get(role, {}) if key != "reports"
            ],
            "report_writer": config["buckets"]["reports"] if role == "holdout" else None,
        }
    return output, bindings


def cloud_read(config):
    project = config["project"]
    checks = (
        [
            ["artifacts", "docker", "images", "describe", item["image"]]
            for item in config["services"].values()
        ]
        + [
            ["iam", "service-accounts", "describe", item["account"]]
            for item in config["services"].values()
        ]
        + [
            ["storage", "buckets", "describe", "gs://" + value]
            for value in config["buckets"].values()
        ]
        + [
            ["secrets", "versions", "describe", version, "--secret", name]
            for name, version in (item.split(":") for item in config["secrets"].values())
        ]
    )
    for index, args in enumerate(checks, 1):
        completed = subprocess.run(
            ["gcloud", *args, "--project", project, "--quiet"],
            capture_output=True,
            timeout=30,
            check=False,
        )
        if completed.returncode:
            raise ValueError(f"cloud_inventory_check_{index}_failed")
    print(f"Read-only cloud inventory verified ({len(checks)} resources)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", choices=("fixture", "staging", "production"), required=True)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify-remote", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    path = args.config or (
        Path("infra/cloud-run/fixture.example.json") if args.env == "fixture" else None
    )
    if path is None:
        parser.error("Set DEPLOY_CONFIG to the approved hosted configuration")
    if args.env == "fixture" and args.verify_remote:
        parser.error("Remote checks require hosted configuration")
    try:
        config = json.loads(path.read_text())
        validate(config, args.env)
        resources, bindings = manifests(config)
        if args.verify_remote:
            cloud_read(config)
        if args.output:
            args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
            for name, value in {**resources, "iam-plan": bindings}.items():
                (args.output / f"{name}.json").write_text(json.dumps(value, indent=2) + "\n")
    except (OSError, KeyError, TypeError, ValueError, subprocess.TimeoutExpired) as error:
        code = (
            str(error)
            if isinstance(error, ValueError) and re.fullmatch("[a-z0-9_]+", str(error))
            else type(error).__name__
        )
        raise SystemExit(f"Deployment preflight stopped ({code})") from None
    print(
        f"Deployment plan validated for {args.env}: "
        f"{len(resources) - 1} services and one isolated job"
    )


if __name__ == "__main__":
    main()
