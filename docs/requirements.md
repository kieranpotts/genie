# Requirements

I require a secure architecture for running agents away-from-keyboard (ie. with
minimal human oversight). Specifically, I require:

* A security profile suitable for using agents in the context of regulated
  industries like finance. I work in these problem spaces.

* Filesystem isolation. A compromised agent or misbehaving model must not be
  able to access files outside of the project scope, nor host files, nor
  cloud credentials or other secrets, and not even host Docker control.

* **One project per stack.** A running harness is scoped to exactly one
  project, mounted at `/workspace`. This is a requirement, not a limitation
  I have yet to lift: multi-project support would mean the agent could name
  a second project's path, which turns "outside the project scope" from a
  single directory boundary into a per-project permission model the MCP
  filesystem server does not implement. Working on two projects means
  bringing up two stacks with different `PROJECT_PATH` values. The isolation
  requirement above is only as simple as it is because of this one.

* Full observability and auditability of every action the agent takes against
  the filesystem.

* Easy portability between development environments. As a software contractor,
  I frequently move between different programming environments.
