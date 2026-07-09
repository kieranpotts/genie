# Alternative designs

I considered three other isolation models before settling on this one:

* **Pi running as a process inside each project's own devcontainer.**
  This approach was rejected as it still allowed unmediated read/write to the
  whole project workspace, with no policy enforcement gate.

* **Pi running in its own container sharing named volumes with devcontainers.**
  This approach was rejected because it still gives direct access to (parts of)
  the host filesystem. The only gate is the volumes that happen to be mounted
  within the network. No fine-grained control over which filesystem operations
  are allowed.

* **Pi running in its own container** with no mounts, instead
  **executing commands inside devcontainers via `docker.sock` or SSH**.
  This approach was also rejected, as it required granting a broad, dangerous
  host privileges, and mediation is only shell-level and not structured or
  auditable.
