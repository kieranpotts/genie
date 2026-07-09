# Alternative designs

I considered three other isolation models before settling on this one:

- **Pi running as a process inside each project's own devcontainer.**
  This approach was rejected as it still allowed unmediated read/write to the
  project workspace, with no policy enforcement gate.

  ```mermaid
  flowchart LR
    subgraph dc["project-a devcontainer (= the only boundary)"]
      pi["Pi process<br/>+ cloud keys"]
      ws[("/workspace")]
      pi -->|"direct read/write<br/>(unmediated)"| ws
    end
    classDef agent fill:#f5f7ff,stroke:#2c5fb3,color:#000;
    classDef danger fill:#fff0f0,stroke:#c0392b,color:#000;
    class pi agent;
    class ws danger;
  ```

- **Pi running in its own container sharing named volumes with devcontainers.**
  This approach was rejected because it still gives direct access to (parts of)
  the host filesystem. The only gate is the volumes that happen to be mounted
  within the network. No fine-grained control over which filesystem operations
  are allowed.

  ```mermaid
  flowchart LR
    subgraph net["Docker network: agent-net"]
      pi["pi-container<br/>Pi + cloud keys"]
      vola[("proj-a volume")]
      volb[("proj-b volume")]
      dca["project-a devcontainer"]
      dcb["project-b devcontainer"]
      pi -->|"direct read/write<br/>(unmediated)"| vola
      pi -->|"direct read/write<br/>(unmediated)"| volb
      dca --- vola
      dcb --- volb
    end
    classDef agent fill:#f5f7ff,stroke:#2c5fb3,color:#000;
    classDef danger fill:#fff0f0,stroke:#c0392b,color:#000;
    class pi agent;
    class vola,volb danger;
  ```

- **Pi running in its own container** with no mounts, instead
  **executing commands inside devcontainers via `docker.sock` or SSH**.
  This approach was also rejected, as it required granting a broad, dangerous
  host privileges, and mediation is only shell-level and not structured or
  auditable.

  ```mermaid
  flowchart LR
    subgraph net["Docker network: agent-net"]
      pi["pi-container<br/>Pi + cloud keys<br/><b>no FS mounts</b>"]
      sock["docker.sock<br/>(or restricted exec proxy)"]
      dca["project-a devcontainer<br/>/workspace"]
      dcb["project-b devcontainer<br/>/workspace"]
      pi -->|"exec / SSH"| sock
      sock -->|"runs commands in"| dca
      sock -->|"runs commands in"| dcb
    end
    classDef agent fill:#f5f7ff,stroke:#2c5fb3,color:#000;
    classDef danger fill:#fff0f0,stroke:#c0392b,color:#000;
    class pi agent;
    class sock danger;
  ```
