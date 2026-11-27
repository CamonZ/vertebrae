//! Generated wire answers against an independent reading of GitHub's check
//! contract. The oracle classifies each wire context from decision tables
//! (which conclusions count as failed, which slugs are Actions) and derives
//! the expected re-run and cancel verdicts from the whole snapshot, so a
//! normalisation slip shows up as a mismatched check rather than a shared
//! mistake. It cannot catch a misreading of GitHub's documentation that the
//! tables repeat, nor anything outside `checks_from_node`'s inputs (the
//! request and step lookup paths are covered by the wiremock tests).

use super::*;
use crate::error::MAX_MESSAGE_CHARS;
use hegel::{generators as gs, TestCase};

/// The check run conclusions GitHub documents: the outcome each names, and
/// whether it counts as failed.
const CONCLUSIONS: &[(&str, CheckOutcome, bool)] = &[
    ("SUCCESS", CheckOutcome::Success, false),
    ("NEUTRAL", CheckOutcome::Neutral, false),
    ("SKIPPED", CheckOutcome::Skipped, false),
    ("FAILURE", CheckOutcome::Failure, true),
    ("CANCELLED", CheckOutcome::Cancelled, true),
    ("TIMED_OUT", CheckOutcome::TimedOut, true),
    ("ACTION_REQUIRED", CheckOutcome::ActionRequired, true),
    ("STARTUP_FAILURE", CheckOutcome::StartupFailure, true),
    ("STALE", CheckOutcome::Stale, true),
];
const RUN_STATUSES: &[&str] = &[
    "COMPLETED",
    "IN_PROGRESS",
    "QUEUED",
    "REQUESTED",
    "WAITING",
    "PENDING",
];
const STATUS_STATES: &[&str] = &["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"];
const PERMISSIONS: &[&str] = &["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"];
const WRITE_PERMISSIONS: &[&str] = &["ADMIN", "MAINTAIN", "WRITE"];

/// Draws one wire answer. A `documented` answer uses only the states and
/// conclusions GitHub documents, so it must normalise; otherwise any enum
/// field may be arbitrary UTF-8 (which may happen to be a documented value;
/// the oracle reads what was drawn). Free text is arbitrary either way.
struct Wire<'a> {
    tc: &'a TestCase,
    documented: bool,
}

impl Wire<'_> {
    fn known_or_text(&self, known: &[&str]) -> String {
        if self.documented || self.tc.draw(gs::weighted_booleans(0.7)) {
            self.tc.draw(gs::sampled_from(known)).to_string()
        } else {
            self.tc.draw(gs::text().max_size(12))
        }
    }

    /// Absent, blank, short, or past the message bound.
    fn free_text(&self) -> Option<String> {
        let tc = self.tc;
        match tc.draw(gs::integers::<u8>().max_value(4)) {
            0 => None,
            1 => Some(
                tc.draw(gs::sampled_from(&["", "   ", "\n\t"][..]))
                    .to_string(),
            ),
            2 => Some(format!(
                "  {}  ",
                tc.draw(
                    gs::text()
                        .min_size(MAX_MESSAGE_CHARS - 2)
                        .max_size(MAX_MESSAGE_CHARS + 4)
                )
            )),
            _ => Some(tc.draw(gs::text().max_size(20))),
        }
    }

    fn optional_text(&self) -> Option<String> {
        self.tc
            .draw(gs::booleans())
            .then(|| self.tc.draw(gs::text().max_size(16)))
    }

    /// Biased towards completed GitHub Actions jobs in a few shared workflow
    /// runs, so failed jobs next to pending ones of the same run are common.
    fn check_run(&self, database_id: u64) -> Value {
        let tc = self.tc;
        let status = if tc.draw(gs::booleans()) {
            "COMPLETED".to_string()
        } else {
            self.known_or_text(RUN_STATUSES)
        };
        let completed = status == "COMPLETED";
        let conclusion = (completed || tc.draw(gs::booleans()))
            .then(|| {
                // Failures twice, so failed jobs are common.
                let mut known: Vec<&str> = CONCLUSIONS
                    .iter()
                    .chain(CONCLUSIONS.iter().filter(|(_, _, failed)| *failed))
                    .map(|(name, _, _)| *name)
                    .collect();
                if !self.documented {
                    known.push("ERROR");
                }
                self.known_or_text(&known)
            })
            .filter(|_| self.documented || tc.draw(gs::weighted_booleans(0.9)));
        let app = match tc.draw(gs::integers::<u8>().max_value(5)) {
            0 => Value::Null,
            1 => json!({ "name": tc.draw(gs::text().max_size(10)), "slug": self.optional_text() }),
            2 => json!({ "name": "Synthetic CI", "slug": "synthetic-ci" }),
            _ => json!({ "name": "GitHub Actions", "slug": "github-actions" }),
        };
        let workflow_run = tc.draw(gs::weighted_booleans(0.85)).then(
            || json!({ "databaseId": tc.draw(gs::integers::<u64>().min_value(900).max_value(902)) }),
        );
        let check_suite = if tc.draw(gs::weighted_booleans(0.9)) {
            json!({ "app": app, "workflowRun": workflow_run })
        } else {
            Value::Null
        };
        json!({
            "__typename": "CheckRun",
            "id": format!("CR_{database_id}"),
            "databaseId": database_id,
            "name": self.known_or_text(&["test", "build", "lint", "docs"]),
            "status": status,
            "conclusion": conclusion,
            "startedAt": self.optional_text(),
            "completedAt": self.optional_text(),
            "url": self.optional_text(),
            "detailsUrl": self.optional_text(),
            "title": self.free_text(),
            "checkSuite": check_suite,
        })
    }

    fn status_context(&self) -> Value {
        let target_url = if self.tc.draw(gs::booleans()) {
            json!("")
        } else {
            json!(self.optional_text())
        };
        json!({
            "__typename": "StatusContext",
            "context": self.known_or_text(&["ci/lint", "ci/external", "buildkite/ci/deep", "plain"]),
            "state": self.known_or_text(STATUS_STATES),
            "description": self.free_text(),
            "targetUrl": target_url,
            "createdAt": self.optional_text(),
        })
    }

    /// A pull request node with its contexts, as the checks query returns it.
    fn pull_request_node(&self) -> Value {
        let tc = self.tc;
        let count = tc.draw(gs::integers::<u64>().max_value(10));
        let contexts: Vec<Value> = (1..=count)
            .map(
                |database_id| match tc.draw(gs::integers::<u8>().max_value(9)) {
                    0 => Value::Null,
                    1..=3 => self.status_context(),
                    _ => self.check_run(database_id),
                },
            )
            .collect();
        let total = (count + tc.draw(gs::integers::<u64>().max_value(4))).saturating_sub(2);
        let state = self.known_or_text(&["OPEN", "OPEN", "MERGED", "CLOSED"]);
        let mut node = pull(7, &state, tc.draw(gs::booleans()), contexts, total);
        match tc.draw(gs::integers::<u8>().max_value(9)) {
            0 => node["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = Value::Null,
            1 => node["commits"]["nodes"] = json!([]),
            _ => {}
        }
        node
    }
}

fn wire_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value[field].as_str()
}

fn owned(value: &Value, field: &str) -> Option<String> {
    wire_str(value, field).map(str::to_owned)
}

fn conclusion(raw: &str) -> Option<(CheckOutcome, bool)> {
    CONCLUSIONS
        .iter()
        .find(|(name, _, _)| *name == raw)
        .map(|&(_, outcome, failed)| (outcome, failed))
}

/// Free text as shown: trimmed, and past `MAX_MESSAGE_CHARS` characters cut
/// there with an ellipsis.
fn bounded(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() > MAX_MESSAGE_CHARS {
        trimmed
            .chars()
            .take(MAX_MESSAGE_CHARS)
            .chain(['…'])
            .collect()
    } else {
        trimmed.to_string()
    }
}

/// What a check must come out as, before snapshot-wide re-run holds.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Expected {
    id: String,
    name: String,
    provider: String,
    status: CheckStatus,
    outcome: Option<CheckOutcome>,
    started_at: Option<String>,
    completed_at: Option<String>,
    url: Option<String>,
    summary: Option<String>,
    actions_job_id: Option<u64>,
    actions_run_id: Option<u64>,
}

/// `None` when GitHub's contract does not define the context (a decode error).
fn expected_check(context: &Value) -> Option<Expected> {
    let summary = |field: &str| {
        wire_str(context, field)
            .map(bounded)
            .filter(|s| !s.is_empty())
    };
    if context["__typename"] == "StatusContext" {
        let name = wire_str(context, "context")?.to_string();
        let state = wire_str(context, "state")?;
        let (status, outcome) = match state {
            "SUCCESS" => (CheckStatus::Passed, Some(CheckOutcome::Success)),
            "FAILURE" => (CheckStatus::Failed, Some(CheckOutcome::Failure)),
            "ERROR" => (CheckStatus::Failed, Some(CheckOutcome::Error)),
            "PENDING" => (CheckStatus::Running, None),
            "EXPECTED" => (CheckStatus::Queued, None),
            _ => return None,
        };
        let created = owned(context, "createdAt");
        let final_state = matches!(status, CheckStatus::Passed | CheckStatus::Failed);
        return Some(Expected {
            id: format!("status:{name}"),
            provider: name.split('/').next().unwrap_or_default().to_string(),
            name,
            status,
            outcome,
            started_at: if final_state { None } else { created.clone() },
            completed_at: if final_state { created } else { None },
            url: owned(context, "targetUrl").filter(|url| !url.is_empty()),
            summary: summary("description"),
            actions_job_id: None,
            actions_run_id: None,
        });
    }

    let (status, outcome) = match wire_str(context, "status")? {
        "COMPLETED" => {
            let (outcome, failed) = conclusion(wire_str(context, "conclusion").unwrap_or(""))?;
            let status = if failed {
                CheckStatus::Failed
            } else {
                CheckStatus::Passed
            };
            (status, Some(outcome))
        }
        "IN_PROGRESS" => (CheckStatus::Running, None),
        _ => (CheckStatus::Queued, None),
    };
    let suite = &context["checkSuite"];
    let is_actions = suite["app"]["slug"] == "github-actions";
    let database_id = context["databaseId"].as_u64()?;
    let (own, provider_page) = (owned(context, "url"), owned(context, "detailsUrl"));
    Some(Expected {
        id: format!("run:{database_id}"),
        name: owned(context, "name")?,
        provider: owned(&suite["app"], "name").unwrap_or_else(|| "GitHub".into()),
        status,
        outcome,
        started_at: owned(context, "startedAt"),
        completed_at: owned(context, "completedAt"),
        url: if is_actions {
            own.or(provider_page)
        } else {
            provider_page.or(own)
        },
        summary: summary("title"),
        actions_job_id: is_actions.then_some(database_id),
        actions_run_id: suite["workflowRun"]["databaseId"]
            .as_u64()
            .filter(|_| is_actions),
    })
}

fn is_pending(status: CheckStatus) -> bool {
    matches!(status, CheckStatus::Running | CheckStatus::Queued)
}

/// The re-run verdict GitHub would accept, from the whole snapshot: a job
/// re-run is refused while any job of its workflow run is still pending.
fn expected_rerun(check: &Expected, all: &[Expected], open: bool, write: bool) -> CheckRerun {
    let run_pending = check.actions_run_id.is_some_and(|run| {
        all.iter()
            .any(|other| other.actions_run_id == Some(run) && is_pending(other.status))
    });
    if check.status != CheckStatus::Failed {
        CheckRerun::NotApplicable
    } else if check.actions_job_id.is_none() {
        CheckRerun::Provider
    } else if !open {
        CheckRerun::PullRequestClosed
    } else if !write {
        CheckRerun::NoPermission
    } else if run_pending {
        CheckRerun::RunInProgress
    } else {
        CheckRerun::Allowed
    }
}

fn expected_cancel(check: &Expected, write: bool) -> CheckCancel {
    if !is_pending(check.status) {
        CheckCancel::NotApplicable
    } else if check.actions_run_id.is_none() {
        CheckCancel::Provider
    } else if !write {
        CheckCancel::NoPermission
    } else {
        CheckCancel::Allowed
    }
}

/// For any wire answer: unknown states and conclusions are decode errors,
/// never panics; otherwise every context comes out once, classified as the
/// oracle says, with re-run held while its workflow run is pending, cancel
/// only for pending Actions runs the viewer may write to, display order by
/// (status, name), and bounded free text.
#[hegel::test(test_cases = 300)]
fn normalised_checks_match_the_wire_contract(tc: TestCase) {
    let documented = tc.draw(gs::weighted_booleans(0.75));
    let wire = Wire {
        tc: &tc,
        documented,
    };
    let node_json = wire.pull_request_node();
    let permission = match tc.draw(gs::integers::<u8>().max_value(5)) {
        0 => None,
        1 => Some(tc.draw(gs::text().max_size(8))),
        _ => Some(wire.known_or_text(PERMISSIONS)),
    };
    tc.note(&format!(
        "documented={documented} permission={permission:?}\nnode={node_json:#}"
    ));
    let write = permission
        .as_deref()
        .is_some_and(|permission| WRITE_PERMISSIONS.contains(&permission));
    let node: ChecksPullRequestNode = serde_json::from_value(node_json.clone()).unwrap();
    let result = checks_from_node(node, can_write(permission.as_deref()));

    let state = (
        node_json["state"].as_str().unwrap(),
        node_json["isDraft"] == true,
    );
    let expected_state = match state {
        ("OPEN", true) => Some(PullRequestState::Draft),
        ("OPEN", false) => Some(PullRequestState::Open),
        ("MERGED", _) => Some(PullRequestState::Merged),
        ("CLOSED", _) => Some(PullRequestState::Closed),
        _ => None,
    };
    let rollup = &node_json["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"];
    let wire_nodes = rollup["nodes"].as_array().cloned().unwrap_or_default();
    let contexts: Vec<&Value> = wire_nodes.iter().filter(|node| !node.is_null()).collect();
    let classified: Option<Vec<Expected>> = contexts.iter().map(|c| expected_check(c)).collect();

    let (Some(expected_state), Some(classified)) = (expected_state, classified) else {
        assert!(!documented, "documented values must normalise");
        assert!(
            matches!(result, Err(GitHubError::Decode { .. })),
            "undefined wire values must be decode errors: {result:?}"
        );
        return;
    };
    let (checks, failed_runs) = result.expect("a well-formed answer normalises");
    assert_eq!(checks.pull_request.state, expected_state);
    assert_eq!(checks.viewer_can_write, write);
    assert_eq!(checks.head_sha, SHA);
    assert_eq!(
        checks.truncated,
        rollup["totalCount"].as_u64().unwrap_or(0) > wire_nodes.len() as u64
    );
    let open = matches!(
        expected_state,
        PullRequestState::Open | PullRequestState::Draft
    );

    // Each context exactly once, as classified.
    let mut want: Vec<_> = classified
        .iter()
        .map(|check| {
            (
                check.clone(),
                expected_rerun(check, &classified, open, write),
                expected_cancel(check, write),
            )
        })
        .collect();
    let mut got: Vec<_> = checks
        .checks
        .iter()
        .map(|check| {
            assert_eq!(check.failed_step, None, "steps are filled in later");
            (
                Expected {
                    id: check.id.clone(),
                    name: check.name.clone(),
                    provider: check.provider.clone(),
                    status: check.status,
                    outcome: check.outcome,
                    started_at: check.started_at.clone(),
                    completed_at: check.completed_at.clone(),
                    url: check.url.clone(),
                    summary: check.summary.clone(),
                    actions_job_id: check.actions_job_id,
                    actions_run_id: check.actions_run_id,
                },
                check.rerun,
                check.cancel,
            )
        })
        .collect();
    want.sort_by_key(|entry| format!("{entry:?}"));
    got.sort_by_key(|entry| format!("{entry:?}"));
    assert_eq!(got, want);

    // Display order.
    assert!(checks
        .checks
        .windows(2)
        .all(|pair| (pair[0].status, &pair[0].name) <= (pair[1].status, &pair[1].name)));
    assert_eq!(
        checks.has_pending(),
        classified.iter().any(|check| is_pending(check.status))
    );

    // Failed Actions jobs come back for the step lookup, with their node ids.
    let mut want_runs: Vec<(u64, String)> = classified
        .iter()
        .filter(|check| check.status == CheckStatus::Failed)
        .filter_map(|check| check.actions_job_id)
        .map(|job| (job, format!("CR_{job}")))
        .collect();
    let mut got_runs = failed_runs;
    want_runs.sort();
    got_runs.sort();
    assert_eq!(got_runs, want_runs);
}

/// The failing step is the first step whose conclusion is a failure, bounded;
/// a run with no failed step (or arbitrary names and conclusions) never panics
/// and reports none.
#[hegel::test(test_cases = 200)]
fn the_failing_step_is_the_first_failed_one_and_bounded(tc: TestCase) {
    let wire = Wire {
        tc: &tc,
        documented: false,
    };
    let count = tc.draw(gs::integers::<usize>().max_value(6));
    let steps: Vec<Value> = (0..count)
        .map(|_| {
            if tc.draw(gs::weighted_booleans(0.1)) {
                return Value::Null;
            }
            let known: Vec<&str> = CONCLUSIONS.iter().map(|(name, _, _)| *name).collect();
            json!({
                "name": wire.free_text().unwrap_or_default(),
                "conclusion": tc.draw(gs::weighted_booleans(0.8)).then(|| wire.known_or_text(&known)),
            })
        })
        .collect();
    let wire = json!({ "databaseId": 11, "steps": { "nodes": steps } });
    tc.note(&format!("{wire:#}"));
    let first_failed = steps
        .iter()
        .find(|step| {
            step["conclusion"]
                .as_str()
                .and_then(conclusion)
                .is_some_and(|(_, failed)| failed)
        })
        .map(|step| step["name"].as_str().unwrap().to_owned());

    let found = first_failed_step(serde_json::from_value(wire).unwrap());
    assert_eq!(found, first_failed.as_deref().map(bounded));
}

/// The pull request numbers one checks query asks for, from its aliases.
fn queried_numbers(request: &Request) -> Vec<u64> {
    let body: Value = serde_json::from_slice(&request.body).unwrap();
    body["query"]
        .as_str()
        .unwrap()
        .lines()
        .filter_map(|line| line.split_once(": pullRequest(number: "))
        .map(|(alias, rest)| {
            let number: u64 = rest.split_once(')').unwrap().0.parse().unwrap();
            assert_eq!(alias.trim(), format!("pr{number}"));
            number
        })
        .collect()
}

/// How GitHub answers one pull request of a checks query.
const FOUND: u8 = 0;
/// `null`, with a `NOT_FOUND` error at its alias.
const NOT_FOUND: u8 = 1;
/// Left out of the answer, without an error.
const LEFT_OUT: u8 = 2;
/// Present, with an error inside it (checks that failed to resolve).
const PARTLY_FAILED: u8 = 3;

/// How GitHub answers a whole checks query, past the normal answers `0..=6`.
const NO_REPOSITORY: u8 = 7;
const NO_REPOSITORY_FORBIDDEN: u8 = 8;
const RATE_LIMITED_BESIDE_DATA: u8 = 9;
/// A repository field (not a pull request) failed beside the data.
const REPOSITORY_FIELD_FAILED: u8 = 10;
/// Seconds until the rate-limit window every answer reports resets.
const RESET_IN_SECS: u64 = 600;

/// The answer to one checks query: each number answered as `answers` says,
/// the rate-limit window shrinking with the first number asked.
fn checks_answer(request: &Request, answers: &[u8], whole: u8) -> ResponseTemplate {
    let queried = queried_numbers(request);
    let mut repository = json!({ "viewerPermission": "WRITE" });
    let mut errors = Vec::new();
    for &number in &queried {
        let alias = format!("pr{number}");
        let answer = answers[number as usize];
        if matches!(answer, FOUND | PARTLY_FAILED) {
            repository[&alias] = open_pull(number, vec![]);
        }
        match answer {
            NOT_FOUND => {
                repository[&alias] = Value::Null;
                errors.push(json!({ "type": "NOT_FOUND", "path": ["repository", alias], "message": "No such pull request" }));
            }
            PARTLY_FAILED => errors.push(json!({
                "type": "SERVICE_UNAVAILABLE",
                "path": ["repository", alias, "commits", "nodes", 0, "commit", "statusCheckRollup"],
                "message": "Something went wrong while resolving checks."
            })),
            _ => {}
        }
    }
    match whole {
        NO_REPOSITORY => repository = Value::Null,
        NO_REPOSITORY_FORBIDDEN => {
            repository = Value::Null;
            errors.push(
                json!({ "type": "FORBIDDEN", "path": ["repository"], "message": "No access" }),
            );
        }
        RATE_LIMITED_BESIDE_DATA => {
            errors.push(json!({ "type": "RATE_LIMITED", "message": "Slow down" }))
        }
        REPOSITORY_FIELD_FAILED => {
            repository["viewerPermission"] = Value::Null;
            errors.push(json!({
                "type": "SERVICE_UNAVAILABLE",
                "path": ["repository", "viewerPermission"],
                "message": "Could not resolve the viewer's permission."
            }));
        }
        _ => {}
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    ResponseTemplate::new(200)
        .insert_header("x-ratelimit-remaining", (4900 - queried[0]).to_string())
        .insert_header("x-ratelimit-reset", (now + RESET_IN_SECS).to_string())
        .set_body_json(json!({ "data": { "repository": repository }, "errors": errors }))
}

/// Any list of pull request numbers, duplicates included, costs one query
/// per `PULL_REQUESTS_PER_QUERY` distinct numbers: every query is full but
/// the last, no number is asked twice, and every number gets exactly one
/// answer, failing alone when GitHub could not resolve it. The batch keeps
/// the tightest rate-limit window. A zero anywhere is rejected before any
/// request; a query GitHub fails as a whole (a repository field included)
/// fails the batch at once, a rate limit retrying when the window resets.
/// The explicit cases span several queries with every per-PR answer, and
/// fail a query in each whole way.
#[hegel::test(test_cases = 25)]
#[hegel::explicit_test_case(
    numbers = (1..=2 * PULL_REQUESTS_PER_QUERY as u64).chain([3, 3]).collect::<Vec<u64>>(),
    answers = (0..46u8).map(|number| number % 4).collect::<Vec<u8>>(),
    whole = 0u8
)]
#[hegel::explicit_test_case(numbers = vec![4u64], answers = vec![FOUND; 46], whole = NO_REPOSITORY)]
#[hegel::explicit_test_case(numbers = vec![4u64], answers = vec![NOT_FOUND; 46], whole = NO_REPOSITORY_FORBIDDEN)]
#[hegel::explicit_test_case(numbers = vec![4u64], answers = vec![FOUND; 46], whole = RATE_LIMITED_BESIDE_DATA)]
#[hegel::explicit_test_case(numbers = vec![4u64], answers = vec![FOUND; 46], whole = REPOSITORY_FIELD_FAILED)]
fn pull_requests_are_asked_for_once_in_bounded_queries(tc: TestCase) {
    let numbers = tc.draw(
        gs::vecs(gs::integers::<u64>().max_value(45)).max_size(3 * PULL_REQUESTS_PER_QUERY + 5),
    );
    let answers = tc.draw(
        gs::vecs(gs::integers::<u8>().max_value(PARTLY_FAILED))
            .min_size(46)
            .max_size(46),
    );
    let whole = tc.draw(gs::integers::<u8>().max_value(REPOSITORY_FIELD_FAILED));
    tc.note(&format!("numbers={numbers:?} whole={whole}"));
    let unique: std::collections::BTreeSet<u64> = numbers.iter().copied().collect();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let server = MockServer::start().await;
        let answered_with = answers.clone();
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(move |request: &Request| checks_answer(request, &answered_with, whole))
            .mount(&server)
            .await;
        let client = GitHubClient::with_base_url(&server.uri()).unwrap();
        let result = client
            .pull_requests_checks(&token(), &demo_repo(), &numbers)
            .await;
        let requests = server.received_requests().await.unwrap();

        if unique.contains(&0) {
            assert!(matches!(result, Err(GitHubError::InvalidInput { .. })));
            assert!(requests.is_empty());
            return;
        }
        if whole >= NO_REPOSITORY && !unique.is_empty() {
            let err = result.unwrap_err();
            assert!(
                match whole {
                    NO_REPOSITORY => matches!(err, GitHubError::NotFound { .. }),
                    NO_REPOSITORY_FORBIDDEN => matches!(err, GitHubError::Forbidden { .. }),
                    REPOSITORY_FIELD_FAILED => matches!(err, GitHubError::GraphQl { .. }),
                    _ => matches!(
                        err,
                        GitHubError::RateLimited { retry_after_secs: Some(secs), .. }
                            if (RESET_IN_SECS - 5..=RESET_IN_SECS).contains(&secs)
                    ),
                },
                "{err:?}"
            );
            assert_eq!(requests.len(), 1);
            return;
        }
        let batch = result.unwrap();
        assert_eq!(
            requests.len(),
            unique.len().div_ceil(PULL_REQUESTS_PER_QUERY)
        );
        let mut asked = Vec::new();
        for (index, request) in requests.iter().enumerate() {
            let queried = queried_numbers(request);
            let last = index + 1 == requests.len();
            assert!(queried.len() <= PULL_REQUESTS_PER_QUERY);
            assert!(last || queried.len() == PULL_REQUESTS_PER_QUERY);
            asked.extend(queried);
        }
        asked.sort_unstable();
        assert_eq!(asked, unique.iter().copied().collect::<Vec<_>>());
        let answered: std::collections::BTreeSet<u64> =
            batch.pull_requests.keys().copied().collect();
        assert_eq!(answered, unique);
        for (number, answer) in &batch.pull_requests {
            assert!(
                match answers[*number as usize] {
                    FOUND => answer.is_ok(),
                    NOT_FOUND | LEFT_OUT => matches!(answer, Err(GitHubError::NotFound { .. })),
                    _ => matches!(answer, Err(GitHubError::GraphQl { .. })),
                },
                "#{number}: {answer:?}"
            );
        }
        let tightest = requests
            .iter()
            .map(|request| 4900 - queried_numbers(request)[0])
            .min();
        assert_eq!(
            batch.rate_limit.map(|limit| u64::from(limit.remaining)),
            tightest
        );
    });
}
