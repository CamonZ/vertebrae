use super::*;

pub(super) fn inspect_store(info: &Value) -> Result<String, LocalBackendError> {
    if info
        .pointer("/host/security/rootless")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(problem(
            "GUI-managed Podman requires a rootless engine; rootful storage is unsupported",
        ));
    }
    let version = info
        .pointer("/version/Version")
        .or_else(|| info.pointer("/version/version"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut parts = version.trim_start_matches('v').split('.');
    let major = parts
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| problem("Podman returned an invalid engine version"))?;
    let minor = parts
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| problem("Podman returned an invalid engine version"))?;
    if major < 5 || (major == 5 && minor < 6) {
        return Err(problem("GUI-managed local backends require Podman 5.6+"));
    }
    info.pointer("/store/graphRoot")
        .and_then(Value::as_str)
        .filter(|v| v.starts_with('/'))
        .map(str::to_string)
        .ok_or_else(|| problem("Podman did not report an absolute rootless storage path"))
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Connection {
    name: String,
    #[serde(rename = "URI")]
    uri: String,
    identity: String,
    default: bool,
}

pub(super) async fn inspect_machine<R: ProcessRunner>(
    runner: &R,
    cli: &std::path::Path,
    connection_name: &str,
) -> Result<(String, PodmanMachineTarget), LocalBackendError> {
    let output = checked(
        runner,
        clean_request(
            cli,
            "inspect Podman connections",
            ["system", "connection", "list", "--format", "json"],
            QUICK,
        ),
    )
    .await?;
    let connections: Vec<Connection> = parse(&output)?;
    let connection = if connection_name.is_empty() {
        let defaults = connections.iter().filter(|c| c.default).collect::<Vec<_>>();
        if defaults.len() != 1 {
            return Err(problem(
                "select a running local rootless Podman machine connection",
            ));
        }
        defaults[0]
    } else {
        connections
            .iter()
            .find(|c| c.name == connection_name)
            .ok_or_else(|| problem("saved Podman machine connection is missing"))?
    };
    // The local machine registry must independently attest the selected connection.
    let listing = checked(
        runner,
        clean_request(
            cli,
            "list local Podman machines",
            ["machine", "list", "--format", "json"],
            QUICK,
        ),
    )
    .await?;
    let machines: Vec<Value> = parse(&listing)?;
    let name = machines
        .iter()
        .filter_map(|v| {
            v.get("Name")
                .or_else(|| v.get("name"))
                .and_then(Value::as_str)
        })
        .find(|name| *name == connection.name)
        .ok_or_else(|| {
            problem("selected connection is not a registered local rootless Podman machine")
        })?;
    if name.starts_with('-') {
        return Err(problem("invalid Podman machine name"));
    }
    let output = checked(
        runner,
        clean_request(
            cli,
            "inspect local Podman machine",
            ["machine", "inspect", name],
            QUICK,
        ),
    )
    .await?;
    let machines: Vec<Value> = parse(&output)?;
    if machines.len() != 1 {
        return Err(problem("expected one local Podman machine"));
    }
    let machine = &machines[0];
    let endpoint = machine
        .pointer("/ConnectionInfo/PodmanSocket/Path")
        .and_then(Value::as_str)
        .filter(|v| v.starts_with('/'))
        .ok_or_else(|| problem("local Podman machine API socket is missing"))?;
    if machine["Name"].as_str() != Some(name) || machine["State"].as_str() != Some("running") {
        return Err(problem(
            "start the saved Podman machine, then retry local setup",
        ));
    }
    if machine["Rootful"].as_bool() != Some(false) {
        return Err(problem("select the rootless Podman machine connection"));
    }
    let port = machine
        .pointer("/SSHConfig/Port")
        .and_then(Value::as_u64)
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| *v != 0)
        .ok_or_else(|| problem("invalid local Podman machine SSH port"))?;
    let identity = machine
        .pointer("/SSHConfig/IdentityPath")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let user = machine
        .pointer("/SSHConfig/RemoteUsername")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let uri = url::Url::parse(&connection.uri)
        .map_err(|_| problem("invalid Podman machine connection URI"))?;
    if uri.scheme() != "ssh"
        || !matches!(uri.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || uri.port() != Some(port)
        || uri.username() != user
        || user.is_empty()
        || connection.identity != identity
        || !uri.password().unwrap_or_default().is_empty()
        || uri.query().is_some()
        || uri.fragment().is_some()
        || !uri.path().starts_with("/run/user/")
        || !uri.path().ends_with("/podman/podman.sock")
    {
        return Err(problem(
            "Podman connection does not match the registered local machine's rootless identity",
        ));
    }
    Ok((
        format!("unix://{endpoint}"),
        PodmanMachineTarget {
            name: name.to_string(),
            connection: connection.name.clone(),
            uri: connection.uri.clone(),
            identity: identity.to_string(),
            ssh_port: port,
            user: user.to_string(),
        },
    ))
}

pub(super) async fn resolve_target<R: ProcessRunner>(
    runner: &R,
    cli: &std::path::Path,
    provider: PathBuf,
) -> Result<PodmanTarget, LocalBackendError> {
    let (endpoint, machine) = if cfg!(target_os = "macos") {
        let (endpoint, machine) = inspect_machine(runner, cli, "").await?;
        (endpoint, Some(machine))
    } else if cfg!(target_os = "linux") {
        let info = checked(
            runner,
            clean_request(
                cli,
                "inspect native rootless Podman",
                ["--remote=false", "info", "--format", "json"],
                QUICK,
            ),
        )
        .await?;
        let info: Value = parse(&info)?;
        inspect_store(&info)?;
        let socket = info.pointer("/host/remoteSocket/path").and_then(Value::as_str)
            .filter(|v| v.starts_with('/')).ok_or_else(|| problem("start the rootless Podman API socket (systemctl --user start podman.socket), then retry"))?;
        (format!("unix://{socket}"), None)
    } else {
        return Err(problem(
            "GUI-managed Podman currently supports Linux and macOS",
        ));
    };
    let info = checked(
        runner,
        clean_request(
            cli,
            "verify local Podman API socket",
            [
                "--remote",
                "--url",
                endpoint.as_str(),
                "info",
                "--format",
                "json",
            ],
            QUICK,
        ),
    )
    .await?;
    let storage_root = inspect_store(&parse::<Value>(&info)?)?;
    let target = PodmanTarget {
        endpoint,
        storage_root,
        provider,
        machine,
    };
    target.validate()?;
    Ok(target)
}
