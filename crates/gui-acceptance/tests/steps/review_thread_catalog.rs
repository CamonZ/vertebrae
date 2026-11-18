use crate::GuiWorld;
use cucumber::when;
use fantoccini::{Client, ClientBuilder, Locator};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::watch,
    task::JoinSet,
    time::sleep,
};
use uuid::Uuid;

const TIMEOUT: Duration = Duration::from_secs(15);

async fn ipc(client: &Client, command: &str, args: Value) -> Value {
    let reply = ipc_reply(client, command, args).await;
    assert!(reply.get("error").is_none(), "{command} failed: {reply}");
    reply["data"].clone()
}

async fn ipc_reply(client: &Client, command: &str, args: Value) -> Value {
    client
        .execute_async(
            r#"
            const [command, args, done] = arguments;
            window.__TAURI_INTERNALS__.invoke(command, args)
              .then(data => done({data}))
              .catch(error => done({error}));
            "#,
            vec![json!(command), args],
        )
        .await
        .unwrap()
}

async fn save_chat(client: &Client, id: &str, project_path: &Path) {
    save_session(client, id, project_path, None).await;
}

async fn save_session(
    client: &Client,
    id: &str,
    project_path: &Path,
    discussion: Option<(&str, Uuid)>,
) {
    let (parent, thread) = discussion.unzip();
    ipc(
        client,
        "save_local_chat_session_index",
        json!({"input": {"changedIds": [id], "sessions": [{
            "id": id, "label": id, "harness": "claude", "projectPath": project_path,
            "parentChatId": parent, "reviewThreadId": thread,
            "titleUserMessageCount": 0, "messageCount": 1, "lifecycle": "idle", "status": "open",
            "createdAt": "2026-11-01T00:00:00Z", "updatedAt": "2026-11-01T00:00:00Z"
        }]}}),
    )
    .await;
}

async fn delete_chat(client: &Client, id: &str) {
    ipc(
        client,
        "save_local_chat_session_index",
        json!({"input": {"sessions": [], "deletedIds": [id]}}),
    )
    .await;
}

fn thread_payload(parent: &str) -> Value {
    json!({
        "parentChatId": parent, "path": "selection.ts", "side": "RIGHT",
        "homeKind": "worktree", "originalCommitId": "a".repeat(40),
        "originalBlobId": "b".repeat(40), "originalStartLine": 1,
        "originalLine": 2, "startLine": 1, "line": 2, "status": "open",
        "outdatedNoted": false, "originKind": "local", "toolUseId": null, "originRef": null
    })
}

async fn put_thread(client: &Client, project: &str, id: Uuid, payload: Value) {
    ipc(
        client,
        "put_review_thread",
        json!({"projectId": project, "threadId": id, "payload": payload}),
    )
    .await;
}

async fn threads(client: &Client, project: &str) -> Value {
    ipc(client, "list_review_threads", json!({"projectId": project})).await
}

fn data_dir(home: &Path) -> std::path::PathBuf {
    home.join(".local/share/vertebrae")
}

fn peer_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let original = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
    let config = vertebrae_sacrum_client::config_path().unwrap();
    let isolated_config = home.path().join(".config/vertebrae");
    fs::create_dir_all(&isolated_config).unwrap();
    fs::copy(config, isolated_config.join("config.toml")).unwrap();

    let bin = home.path().join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    for name in ["vtb", "vtb-daemon", "vtb-gate"] {
        std::os::unix::fs::symlink(original.join(".local/bin").join(name), bin.join(name)).unwrap();
    }
    let data = data_dir(home.path());
    fs::create_dir_all(&data).unwrap();
    // Scope both GUI processes to the same installation while retaining separate caches.
    fs::copy(
        data_dir(&original).join("chat-installation-id"),
        data.join("chat-installation-id"),
    )
    .unwrap();
    home
}

async fn peer_client(address: &str, home: &Path, slug: &str) -> Client {
    fs::write(
        data_dir(home).join("app-state.json"),
        json!({"current_project_slug": slug}).to_string(),
    )
    .unwrap();

    let options = json!({
        "tauri:options": {
            "application": std::env::var("GUI_BINARY").unwrap_or_else(|_| gui_acceptance::GUI_BINARY.into())
        }
    });
    let client = ClientBuilder::native()
        .capabilities(options.as_object().unwrap().clone())
        .connect(address)
        .await
        .expect("launch isolated review catalog GUI");
    gui_acceptance::wait_for_page(&client, "/tasks", Some(slug)).await;
    client
}

async fn peer_driver(home: &Path, backend: &str) -> (tokio::process::Child, String) {
    let port = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = port.local_addr().unwrap();
    let native_port = native.local_addr().unwrap().port();
    drop((port, native));

    let driver = Command::new("tauri-driver")
        .args([
            "--port",
            &address.port().to_string(),
            "--native-port",
            &native_port.to_string(),
        ])
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("VTB_URL", backend)
        .kill_on_drop(true)
        .spawn()
        .expect("start a second tauri-driver");

    tokio::time::timeout(TIMEOUT, async {
        while tokio::net::TcpStream::connect(address).await.is_err() {
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("second tauri-driver became reachable");
    (driver, format!("http://{address}"))
}

async fn listen_to_threads(client: &Client) {
    let ready = client
        .execute_async(
            r#"
            const done = arguments[0];
            const ipc = window.__TAURI_INTERNALS__;
            window.reviewCatalogEvents = [];
            window.reviewCatalogRecoveries = [];
            function listen(event, received) {
              return ipc.invoke("plugin:event|listen", {
                event,
                target: { kind: "Any" },
                handler: ipc.transformCallback(message => received.push(message.payload)),
              });
            }
            Promise.all([
              listen("review-thread-changed", window.reviewCatalogEvents),
              listen("review-thread-catalog-recovered", window.reviewCatalogRecoveries),
            ]).then(() => done(true), () => done(false));
            "#,
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(ready, json!(true));

    gui_acceptance::wait_until("peer WebSocket", TIMEOUT, || async {
        Ok(ipc(client, "get_websocket_status", json!({})).await == "connected")
    })
    .await
    .unwrap();
}

async fn expect_thread_event(client: &Client, project: &str, id: Uuid, live: bool) {
    gui_acceptance::wait_for_js(
        client,
        &format!("live review thread catalog change for {id}, live={live}"),
        r#"return window.reviewCatalogEvents.some(event => event.projectId === arguments[0]
            && event.threadId === arguments[1] && (event.thread !== null) === arguments[2]);"#,
        vec![json!(project), json!(id), json!(live)],
        TIMEOUT,
    )
    .await;
}

#[when("two GUI processes create, cascade-delete and recover review threads")]
async fn review_thread_cdc_and_recovery(world: &mut GuiWorld) {
    let primary = world.webdriver.as_ref().unwrap().lock().await;
    let project = world.project_id.as_deref().unwrap();
    let slug = world.project_slug.as_deref().unwrap();
    let path = world.temp_dir.as_deref().unwrap();
    let backend = &world.env["VTB_URL"];

    let remove_parent = format!("chat-{}", Uuid::new_v4());
    let keep_parent = format!("chat-{}", Uuid::new_v4());
    save_chat(&primary, &remove_parent, path).await;
    save_chat(&primary, &keep_parent, path).await;

    let home = peer_home();
    let relay = backend_relay(backend).await;
    let (_driver, address) = peer_driver(home.path(), &relay.endpoint).await;
    let peer = peer_client(&address, home.path(), slug).await;
    ipc(&peer, "load_local_chat_session_index", json!({})).await;
    assert_eq!(read_catalog(home.path(), false)["version"], 2);
    assert_eq!(threads(&peer, project).await, json!([]));
    listen_to_threads(&peer).await;

    let removed = Uuid::new_v4();
    let surviving = [Uuid::new_v4(), Uuid::new_v4()];
    put_thread(&primary, project, removed, thread_payload(&remove_parent)).await;
    expect_thread_event(&peer, project, removed, true).await;

    for id in surviving {
        put_thread(&primary, project, id, thread_payload(&keep_parent)).await;
        expect_thread_event(&peer, project, id, true).await;
    }

    // Only the main chat is deleted here. Sacrum owns the cascade.
    delete_chat(&primary, &remove_parent).await;
    expect_thread_event(&peer, project, removed, false).await;
    peer.close().await.unwrap();

    let data = data_dir(home.path());
    for entry in fs::read_dir(&data).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_catalog(&name) {
            fs::remove_file(entry.path()).unwrap();
        }
    }

    let peer = peer_client(&address, home.path(), slug).await;
    listen_to_threads(&peer).await;
    ipc(&peer, "load_local_chat_session_index", json!({})).await;
    gui_acceptance::wait_for_js(
        &peer,
        "review thread recovery notification",
        "return window.reviewCatalogRecoveries.some(event => event.projectId === arguments[0]);",
        vec![json!(project)],
        TIMEOUT,
    )
    .await;

    let recovered = threads(&peer, project).await;
    let ids: std::collections::BTreeSet<_> = recovered
        .as_array()
        .unwrap()
        .iter()
        .map(|thread| Uuid::parse_str(thread["threadId"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(ids, surviving.into_iter().collect());

    let cached = read_catalog(home.path(), false);
    assert_eq!(
        cached["projects"][project][format!("thread:{removed}")]["remote"]["payload"]["deleted"],
        true
    );
    let writes = relay.writes();
    let rejected = ipc_reply(
        &peer,
        "put_review_thread",
        json!({"projectId": project, "threadId": removed, "payload": thread_payload(&keep_parent)}),
    )
    .await;
    assert_eq!(
        rejected["error"]["message"],
        "Review thread has been deleted."
    );
    assert_eq!(
        relay.writes(),
        writes,
        "terminal thread must never reach Sacrum"
    );
    assert_eq!(threads(&peer, project).await, recovered);
    peer.close().await.unwrap();
}

fn is_catalog(file: &str) -> bool {
    file.strip_prefix("chat-catalog-")
        .and_then(|suffix| suffix.strip_suffix(".json"))
        .is_some_and(|scope| {
            scope.len() == 64 && scope.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn read_catalog(home: &Path, diagnostics: bool) -> Value {
    let path = fs::read_dir(data_dir(home))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| is_catalog(path.file_name().unwrap().to_str().unwrap()))
        .expect("account catalog exists");
    let path = if diagnostics {
        path.with_extension("expected.json")
    } else {
        path
    };
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mutation {
    Chat,
    Thread,
}

struct BackendRelay {
    endpoint: String,
    online: watch::Sender<bool>,
    mutations: Arc<Mutex<Vec<Mutation>>>,
}

impl BackendRelay {
    fn writes(&self) -> Vec<Mutation> {
        self.mutations.lock().unwrap().clone()
    }
}

/// Cuts both HTTP and WebSocket for the peer GUI and records only operation
/// kinds from its plaintext GraphQL requests.
async fn backend_relay(backend: &str) -> BackendRelay {
    let upstream = backend
        .strip_prefix("http://")
        .expect("acceptance Sacrum uses HTTP")
        .trim_end_matches('/')
        .to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());

    let (online, mut changes) = watch::channel(true);
    let mutations = Arc::new(Mutex::new(Vec::new()));
    let observed = mutations.clone();

    tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                change = changes.changed() => {
                    if change.is_err() {
                        break;
                    }
                    if !*changes.borrow_and_update() {
                        connections.abort_all();
                    }
                }
                incoming = listener.accept() => {
                    let (browser, _) = incoming.unwrap();
                    if *changes.borrow() {
                        let upstream = upstream.clone();
                        let observed = observed.clone();
                        connections.spawn(async move {
                            if let Ok(backend) = TcpStream::connect(upstream).await {
                                let (requests, mut responses) = browser.into_split();
                                let (mut backend_rx, backend_tx) = backend.into_split();
                                let _ = tokio::try_join!(
                                    relay_requests(requests, backend_tx, &observed),
                                    async {
                                        tokio::io::copy(&mut backend_rx, &mut responses).await?;
                                        responses.shutdown().await
                                    },
                                );
                            }
                        });
                    }
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
    });

    BackendRelay {
        endpoint,
        online,
        mutations,
    }
}

async fn relay_requests(
    mut requests: impl AsyncRead + Unpin,
    mut backend: impl AsyncWrite + Unpin,
    observed: &Mutex<Vec<Mutation>>,
) -> io::Result<()> {
    const CHAT: &[u8] = b"putChatCatalog(";
    const THREAD: &[u8] = b"putReviewThread(";

    let mut buffer = [0; 8192];
    let mut tail = Vec::new();
    loop {
        let count = requests.read(&mut buffer).await?;
        if count == 0 {
            return backend.shutdown().await;
        }

        tail.extend_from_slice(&buffer[..count]);
        let mut start = 0;
        while start < tail.len() {
            let next = &tail[start..];
            let (mutation, width) = if next.starts_with(CHAT) {
                (Mutation::Chat, CHAT.len())
            } else if next.starts_with(THREAD) {
                (Mutation::Thread, THREAD.len())
            } else if next.len() < CHAT.len().max(THREAD.len()) {
                break;
            } else {
                start += 1;
                continue;
            };
            observed.lock().unwrap().push(mutation);
            start += width;
        }

        tail.drain(..start);
        backend.write_all(&buffer[..count]).await?;
    }
}

struct Discussion {
    parent: String,
    thread: Uuid,
    chat: String,
}

impl Discussion {
    fn new() -> Self {
        Self {
            parent: format!("chat-{}", Uuid::new_v4()),
            thread: Uuid::new_v4(),
            chat: format!("chat-{}", Uuid::new_v4()),
        }
    }

    async fn queue_children(&self, client: &Client, project: &str, path: &Path) {
        put_thread(client, project, self.thread, thread_payload(&self.parent)).await;
        save_session(client, &self.chat, path, Some((&self.parent, self.thread))).await;
    }

    fn assert_pending(&self, catalog: &Value, project: &str) {
        assert!(
            catalog["projects"][project][format!("thread:{}", self.thread)]["desired"].is_object()
        );
        assert!(catalog["projects"][project][format!("chat:{}", self.chat)]["desired"].is_object());
    }

    async fn assert_delivered(&self, world: &GuiWorld, project: &str, installation: &str) {
        let client = world.graphql_client.as_ref().unwrap();
        let payload = json!({"project": project, "installation": installation});
        let discussions: Value = client
            .execute(
                "query($project:Uuid4!,$installation:Uuid4!){chatCatalog(projectId:$project,installationId:$installation,includeCompleted:true){entries{chatId payload}}}",
                payload.clone(),
                "chatCatalog",
            )
            .await
            .expect("read Sacrum discussion catalog");
        let threads: Value = client
            .execute(
                "query($project:Uuid4!,$installation:Uuid4!){reviewThreads(projectId:$project,installationId:$installation){entries{threadId payload}}}",
                payload,
                "reviewThreads",
            )
            .await
            .expect("read Sacrum review threads");

        assert!(
            discussions["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| {
                    entry["chatId"] == self.chat
                        && entry["payload"]["review_thread_id"] == json!(self.thread)
                        && entry["payload"]["deleted"] == false
                })
        );
        assert!(threads["entries"].as_array().unwrap().iter().any(|entry| {
            entry["threadId"] == json!(self.thread)
                && entry["payload"]["parent_chat_id"] == self.parent
                && entry["payload"]["deleted"] == false
        }));
    }
}

#[when("an offline GUI queues discussions, including under a parent deleted by another GUI")]
async fn review_thread_outbox_reconnect(world: &mut GuiWorld) {
    let primary = world.webdriver.as_ref().unwrap().lock().await;
    let project = world.project_id.as_deref().unwrap();
    let slug = world.project_slug.as_deref().unwrap();
    let path = world.temp_dir.as_deref().unwrap();
    let other_slug = world.second_project_slug.as_deref().unwrap();
    let other_path = world.second_temp_dir.as_deref().unwrap();

    let removed = Discussion::new();
    save_chat(&primary, &removed.parent, path).await;

    let home = peer_home();
    let relay = backend_relay(&world.env["VTB_URL"]).await;
    let (_driver, address) = peer_driver(home.path(), &relay.endpoint).await;
    let peer = peer_client(&address, home.path(), slug).await;
    ipc(&peer, "load_local_chat_session_index", json!({})).await;

    let projects = ipc(&peer, "get_projects", json!({})).await;
    let other_project = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["slug"] == other_slug)
        .unwrap()["project_id"]
        .as_str()
        .unwrap();

    listen_to_threads(&peer).await;
    let before = relay.writes().len();
    relay.online.send(false).unwrap();
    gui_acceptance::wait_until("peer backend disconnected", TIMEOUT, || async {
        Ok(ipc(&peer, "get_websocket_status", json!({})).await != "connected")
    })
    .await
    .unwrap();

    let first = Discussion::new();
    save_chat(&peer, &first.parent, path).await;
    first.queue_children(&peer, project, path).await;
    let second = Discussion::new();
    save_chat(&peer, &second.parent, other_path).await;
    second
        .queue_children(&peer, other_project, other_path)
        .await;

    let rejected = Uuid::new_v4();
    let mut invalid = thread_payload(&first.parent);
    invalid["line"] = json!(0);
    put_thread(&peer, project, rejected, invalid).await;
    removed.queue_children(&peer, project, path).await;

    let queued = read_catalog(home.path(), false);
    first.assert_pending(&queued, project);
    second.assert_pending(&queued, other_project);
    removed.assert_pending(&queued, project);
    assert!(queued["projects"][project][format!("chat:{}", first.parent)]["desired"].is_object());

    delete_chat(&primary, &removed.parent).await;
    relay.online.send(true).unwrap();
    gui_acceptance::wait_until("reconnect recovers the outbox", TIMEOUT, || async {
        let diagnostics = read_catalog(home.path(), true);
        Ok(diagnostics["pending"] == json!([])
            && diagnostics["pending_threads"] == json!([rejected])
            && diagnostics["rejected"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| {
                    entry["thread_id"] == json!(rejected) && entry["code"] == "invalid_payload"
                }))
    })
    .await
    .unwrap();

    expect_thread_event(&peer, project, removed.thread, false).await;
    let delivered = read_catalog(home.path(), false);
    let records = &delivered["projects"][project];
    assert!(records[format!("chat:{}", removed.chat)]["desired"].is_null());
    assert!(records[format!("thread:{}", removed.thread)]["desired"].is_null());
    assert!(records[format!("thread:{rejected}")]["desired"].is_object());

    use Mutation::{Chat, Thread};
    let writes = relay.writes();
    let writes = &writes[before..];
    let primary_pass = [Chat, Thread, Thread, Chat];
    let secondary_pass = [Chat, Thread, Chat];
    assert!(
        writes.starts_with(&[primary_pass.as_slice(), &secondary_pass].concat())
            || writes.starts_with(&[secondary_pass.as_slice(), &primary_pass].concat()),
        "unexpected delivery order: {writes:?}",
    );

    let installation =
        fs::read_to_string(data_dir(home.path()).join("chat-installation-id")).unwrap();
    first.assert_delivered(world, project, &installation).await;
    second
        .assert_delivered(world, other_project, &installation)
        .await;
    gui_acceptance::click_when_ready(
        &peer,
        Locator::Css("[data-testid='local-chat-launcher']"),
        "chat launcher",
    )
    .await;
    gui_acceptance::click_pane_action(
        &peer,
        "[title='Toggle chat history']",
        "conversation history",
    )
    .await;
    gui_acceptance::wait_for_js(
        &peer,
        "regular chat history shows the main chat and hides the persisted discussion",
        r#"
        const panel = document.querySelector('[data-testid=local-chat-mini-panel]');
        return panel?.innerText.includes(arguments[0]) && !panel.innerText.includes(arguments[1]);
        "#,
        vec![json!(first.parent), json!(first.chat)],
        TIMEOUT,
    )
    .await;
    gui_acceptance::screenshot(&peer, "review-thread-catalog", 1, "regular-chat-history").await;
    peer.close().await.unwrap();
}
