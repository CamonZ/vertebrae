//! `poll` for generated requests and GitHub answers against a direct reading
//! of what each remote should come out as. It shares the conversions
//! (`from_summary`, `GithubPrChecks::new`, `tightest`) with the code under
//! test, which are tested on their own.

use super::*;
use hegel::{generators as gs, TestCase};

const REPOS: &[&str] = &["example/demo-repo", "alice/demo-repo", "not-a-repo"];
const BRANCHES: &[&str] = &["feature/a", "feature/b", "feature/c"];
/// Heads of listed PRs: the watched branches and one nobody watches.
const HEADS: &[&str] = &["feature/a", "feature/b", "feature/c", "feature/other"];
const NUMBERS: &[u32] = &[7, 8, 9];

type LimitDraw = Option<(u32, u64)>;

fn limit(draw: LimitDraw) -> Option<RateLimitStatus> {
    draw.map(|(remaining, reset_in_secs)| RateLimitStatus {
        remaining,
        reset_in_secs,
    })
}

fn draw_limit(tc: &TestCase) -> Option<RateLimitStatus> {
    limit(tc.draw(gs::optional(hegel::tuples!(
        gs::sampled_from(&[0u32, 49, 50, 4000][..]),
        gs::sampled_from(&[0u64, 600, u64::MAX][..])
    ))))
}

fn draw_error(tc: &TestCase) -> GitHubError {
    match tc.draw(gs::integers::<u8>().max_value(2)) {
        0 => GitHubError::AuthExpired {
            message: "token expired".into(),
        },
        1 => GitHubError::RateLimited {
            retry_after_secs: Some(60),
            message: "slow down".into(),
        },
        _ => GitHubError::Network {
            message: "timed out".into(),
        },
    }
}

fn draw_listing(tc: &TestCase) -> Result<OpenPrSearchResult, GitHubError> {
    if tc.draw(gs::weighted_booleans(0.15)) {
        return Err(draw_error(tc));
    }
    let prs = tc
        .draw(
            gs::vecs(hegel::tuples!(
                gs::integers::<u64>().min_value(1).max_value(30),
                gs::sampled_from(HEADS),
                gs::booleans()
            ))
            .max_size(5),
        )
        .into_iter()
        .map(|(number, head, fork)| {
            summary(
                number,
                head,
                Some(if fork {
                    "bob/demo-repo"
                } else {
                    "example/demo-repo"
                }),
            )
        })
        .collect();
    Ok(OpenPrSearchResult {
        prs,
        has_more: tc.draw(gs::booleans()),
        rate_limit: draw_limit(tc),
    })
}

fn draw_checks(tc: &TestCase) -> Result<PullRequestChecksBatch, GitHubError> {
    if tc.draw(gs::weighted_booleans(0.15)) {
        return Err(draw_error(tc));
    }
    let mut entries = Vec::new();
    for &number in NUMBERS {
        match tc.draw(gs::integers::<u8>().max_value(3)) {
            0 => {}
            1 => entries.push((u64::from(number), Err(draw_error(tc)))),
            _ => entries.push((
                u64::from(number),
                Ok(snapshot(
                    u64::from(number),
                    vec![check("run:1", CheckStatus::Running, Some(1))],
                )),
            )),
        }
    }
    Ok(batch(entries, draw_limit(tc)))
}

fn draw_lookup(tc: &TestCase) -> FakeLookup {
    let mut lookup = FakeLookup::default();
    for repo in &REPOS[..2] {
        lookup.open.insert(repo.to_string(), draw_listing(tc));
        lookup.checks.insert(repo.to_string(), draw_checks(tc));
    }
    lookup
}

fn sorted<T: Ord + Clone>(items: &[T]) -> Vec<T> {
    let mut items = items.to_vec();
    items.sort();
    items.dedup();
    items
}

fn pr_view(repo: &RepoRef, pr: &PullRequestSummary) -> GithubPullRequest {
    GithubPullRequest::from_summary(&repo.owner, &repo.repo, pr).unwrap()
}

/// What one remote should answer, and the rate limits its reads reported.
fn expected_remote(
    request: &GithubPrPollRequest,
    lookup: &FakeLookup,
) -> (GithubRemotePoll, Vec<Option<RateLimitStatus>>) {
    let branches = sorted(&request.branches);
    let numbers = sorted(&request.numbers);
    let mut limits = Vec::new();
    let poll = |open_prs, pull_requests| GithubRemotePoll {
        host: request.host.clone(),
        repo: request.repo.clone(),
        open_prs,
        pull_requests,
    };
    let Some((owner, name)) = request.repo.split_once('/') else {
        let failure = GithubFailure::other(format!("{:?} is not owner/name", request.repo));
        let open_prs = if branches.is_empty() {
            GithubOpenPrsPoll::NotRequested
        } else {
            GithubOpenPrsPoll::Failed {
                failure: failure.clone(),
            }
        };
        let prs = numbers
            .iter()
            .map(|&number| GithubPolledPr {
                number,
                result: GithubPolledPrResult::Failed {
                    failure: failure.clone(),
                },
            })
            .collect();
        return (poll(open_prs, prs), limits);
    };
    let repo = RepoRef::new("github.com", owner, name);

    let open_prs = if branches.is_empty() {
        GithubOpenPrsPoll::NotRequested
    } else {
        match &lookup.open[&request.repo] {
            Err(err) => GithubOpenPrsPoll::Failed {
                failure: err.into(),
            },
            Ok(listed) => {
                limits.push(listed.rate_limit);
                // One listing serves every branch; past its pages, none is complete.
                GithubOpenPrsPoll::Read {
                    branches: branches
                        .iter()
                        .map(|branch| GithubBranchPrs {
                            branch: branch.clone(),
                            prs: listed
                                .prs
                                .iter()
                                .filter(|pr| pr.head_ref == *branch)
                                .map(|pr| pr_view(&repo, pr))
                                .collect(),
                            complete: !listed.has_more,
                        })
                        .collect(),
                }
            }
        }
    };

    let pull_requests = if numbers.is_empty() {
        Vec::new()
    } else {
        match &lookup.checks[&request.repo] {
            Err(err) => numbers
                .iter()
                .map(|&number| GithubPolledPr {
                    number,
                    result: GithubPolledPrResult::Failed {
                        failure: err.into(),
                    },
                })
                .collect(),
            Ok(answer) => {
                limits.push(answer.rate_limit);
                numbers
                    .iter()
                    .map(|&number| GithubPolledPr {
                        number,
                        result: match answer.pull_requests.get(&u64::from(number)) {
                            Some(Ok(read)) => GithubPolledPrResult::Read {
                                pr: Box::new(pr_view(&repo, &read.pull_request)),
                                checks: Box::new(GithubPrChecks::new(&repo, read.clone()).unwrap()),
                            },
                            Some(Err(err)) => GithubPolledPrResult::Failed {
                                failure: err.into(),
                            },
                            None => GithubPolledPrResult::Failed {
                                failure: GithubFailure::other(format!(
                                    "GitHub returned nothing for PR #{number}"
                                )),
                            },
                        },
                    })
                    .collect()
            }
        }
    };
    (poll(open_prs, pull_requests), limits)
}

/// Which GitHub reads one remote should make.
fn expected_calls(request: &GithubPrPollRequest) -> Vec<String> {
    let mut calls = Vec::new();
    if !request.repo.contains('/') {
        return calls;
    }
    let branches = sorted(&request.branches);
    let numbers = sorted(&request.numbers);
    if !branches.is_empty() {
        calls.push(format!("open {}", request.repo));
    }
    if !numbers.is_empty() {
        let wanted: Vec<u64> = numbers.iter().copied().map(u64::from).collect();
        calls.push(format!("checks {} {wanted:?}", request.repo));
    }
    calls
}

#[hegel::test(test_cases = 300)]
fn polling_answers_every_remote_from_its_own_reads(tc: TestCase) {
    let requests: Vec<GithubPrPollRequest> = tc
        .draw(
            gs::vecs(hegel::tuples!(
                gs::sampled_from(REPOS),
                gs::vecs(gs::sampled_from(BRANCHES)).max_size(4),
                gs::vecs(gs::sampled_from(NUMBERS)).max_size(4)
            ))
            .max_size(4),
        )
        .into_iter()
        .map(|(repo, branches, numbers)| request(repo, &branches, &numbers))
        .collect();
    let lookup = draw_lookup(&tc);
    tc.note(&format!("requests: {requests:#?}"));

    let polled = futures::executor::block_on(poll(requests.clone(), &lookup));

    let mut limits = Vec::new();
    let mut calls = Vec::new();
    let expected: Vec<GithubRemotePoll> = requests
        .iter()
        .map(|request| {
            let (remote, reported) = expected_remote(request, &lookup);
            limits.extend(reported);
            calls.extend(expected_calls(request));
            remote
        })
        .collect();
    calls.sort();
    let tightest = limits.into_iter().fold(None, RateLimitStatus::tightest);
    assert_eq!(
        polled,
        GithubPrPollBatch {
            remotes: expected,
            hold_off_secs: hold_off_secs(tightest),
        }
    );
    assert_eq!(lookup.calls(), calls);
}
