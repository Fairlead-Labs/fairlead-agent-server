# ADR 0002: One container, no cloud provider required

- Status: **accepted**.
- Requirement: [0002](../requirements/0002-hosting-and-keys.md).

## Context

An open-source server has to run where its deployer runs things. Some
deployers have a cloud's workload identity and key service; others have a
container runtime, Postgres and a secret store.

## Decision

1. **The deliverable is a container image and a configuration reference.**
   No deployment code (Terraform, Helm, compose stacks) lives here. A
   deployment keeps its own, in its own repository.
2. **What depends on a provider is a port with adapters in this
   repository**, chosen by configuration:
   - the key that wraps the teams' keys (`KeyWrapper`): Cloud KMS, or a
     local key;
   - the sign-in to the MCP endpoint: a function that answers a bearer
     token, from a Google identity or from the configuration.
3. **Exactly one adapter per port is configured.** Two set, or none, stops
   the start. Nothing falls back silently to the weaker one.
4. **Identity and a key service stay the recommendation**, said in
   `docs/configuration.md`, not a requirement.
5. **Adapters speak `fetch`.** No provider SDK ([ADR 0001](0001-architecture.md)),
   so one more key service or identity provider is one more small file.
6. **Callers are named by their own credentials:** people by their OIDC
   token, the installation's host by its own credential
   ([ADR 0006](0006-the-host.md)), and later other trigger senders by a
   credential for one team.

## Rejected

- **A plugin system for adapters.** Two adapters per port do not need one.
  Revisit when adapters arrive that cannot live in this repository.
- **Only a local key, cloud key services left to deployers.** A hosted
  deployment needs a key service, and it should run the same code as
  everyone else.
- **A local key as the default when nothing is set.** A server that makes
  its own key at first start loses every sealed value with its first
  container.
- **One shared token for every caller.** It names no caller. The host's
  bearer token names the host alone, and a workload identity is
  recommended over it.

## Consequences

- A team's wrapped key is bound to the adapter that wrapped it. Moving an
  installation between adapters means re-wrapping each team's key: a command
  that does not exist yet.
- With `LOCAL_KEY`, whoever reads the configuration can open every team's
  sealed values; the configuration reference says so.
