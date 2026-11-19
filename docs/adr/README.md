# Architectural Decision Records

Short notes that capture a decision, its context, and the trade-offs accepted. Read [design.md](../design.md) first for the big picture.

Write one when a decision binds work beyond the change that prompted it, or settles a trade-off a future maintainer would otherwise re-open. Don't write one for a choice local to one feature: that belongs in the README, next to the API it explains.

Each ADR is a single file named `NNNN-kebab-case-title.md`, numbered in order, with a **Status** (Proposed, Accepted, or Superseded by ADR-NNNN), a **Date**, and **Context**, **Decision** and **Consequences** sections. ADRs are append-only: to change a decision, write a new ADR that supersedes the old one, and update the old one's status.

This package follows ComposureCDK's ADRs where it says so, such as [ADR-0008](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0008-aws-cdk-lib-version-floors.md) for peer floors. An ADR here that refines one of them says so.

## Index

- [ADR-0001: Versioning and the stable API](0001-versioning-and-stable-api.md)
