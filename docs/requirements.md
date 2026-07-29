# Requirements

I require a secure architecture for running agents away-from-keyboard (ie. with
minimal human oversight). Specifically, I require:

* A security profile suitable for using agents in the context of regulated
  industries like finance. I work in these problem spaces.

* Filesystem isolation. A compromised agent or misbehaving model must not be
  able to access files outside of the project scope, nor host files, nor
  cloud credentials or other secrets, and not even host Docker control.

* Full observability and auditability of every action the agent takes against
  the filesystem.

* Easy portability between development environments. As a software contractor,
  I frequently move between different programming environments.
