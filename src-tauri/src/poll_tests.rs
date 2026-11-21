use crate::{
    jobs::Studio,
    model::{id, Job},
    store::{read, Store},
};
use axum::{body::Body, extract::Request, response::Response, Router};
use serde_json::json;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

async fn server(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", socket.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
    (base, server)
}

fn studio(home: &Path, notify: impl Fn(Option<&str>) + Send + Sync + 'static) -> Studio {
    let mut studio = Studio::new(Store::new(home.to_owned()).unwrap(), notify).unwrap();
    studio.poll = Duration::from_millis(12);
    studio
}

#[tokio::test]
async fn saved_cooldown_resumes_only_the_status_query_and_reports_real_progress() {
    let posts = Arc::new(AtomicUsize::new(0));
    let queries = Arc::new(Mutex::new(Vec::new()));
    let posted = posts.clone();
    let queried = queries.clone();
    let (base, server) = server(Router::new().fallback(move |request: Request| {
        let posts = posted.clone();
        let queries = queried.clone();
        async move {
            if request.method() == "POST" {
                assert_eq!(request.uri().path(), "/v1/videos");
                posts.fetch_add(1, Ordering::SeqCst);
                return Response::new(Body::from(json!({"id":"movie"}).to_string()));
            }
            if request.uri().path() == "/v1/videos/movie/content" {
                return Response::new(Body::from(b"\0\0\0\x18ftypisom\0\0\0\0".as_slice()));
            }
            assert_eq!(request.uri().path(), "/v1/videos/movie");
            let mut times = queries.lock().unwrap();
            times.push(Instant::now());
            let reply = match times.len() {
                1 => {
                    return Response::builder()
                        .status(429)
                        .header("retry-after", "1")
                        .body(Body::empty())
                        .unwrap()
                }
                2 => json!({"status":"queued"}),
                3 | 4 => json!({"status":"in_progress","progress":33}),
                5 => json!({"status":"in_progress","progress":130}),
                6 => return Response::builder().status(503).body(Body::empty()).unwrap(),
                _ => json!({"status":"completed"}),
            };
            Response::new(Body::from(reply.to_string()))
        }
    }))
    .await;
    let home = tempfile::tempdir().unwrap();
    let mut job = Job {
        id: id(),
        protocol_id: "openai-video".into(),
        base_url: base,
        ..Default::default()
    };
    let file = home.path().join("tasks").join(format!("{}.json", job.id));
    let first = studio(home.path(), |_| {});
    let running = tokio::spawn(async move { first.run(&mut job, true).await });
    let mut saved = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(stored) = read::<Job>(&file) {
                if stored.retry_at.is_some() {
                    break stored;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    running.abort();
    let _ = running.await;
    assert_eq!(saved.remote_id.as_deref(), Some("movie"));

    let details = Arc::new(Mutex::new(Vec::new()));
    let seen = details.clone();
    let recovered = studio(home.path(), move |_| {
        seen.lock()
            .unwrap()
            .push(read::<Job>(&file).unwrap().detail)
    });
    recovered.run(&mut saved, false).await.unwrap();
    assert_eq!(saved.status, "done");
    assert!(saved.retry_at.is_none());
    assert_eq!(posts.load(Ordering::SeqCst), 1);
    let times = queries.lock().unwrap();
    assert_eq!(times.len(), 7);
    assert!(times[1].duration_since(times[0]) >= Duration::from_millis(990));
    let changes = details.lock().unwrap();
    assert!(changes.iter().any(|m| m.contains("正在排队")));
    assert_eq!(changes.iter().filter(|m| m.contains("33%")).count(), 1);
    assert!(!changes.iter().any(|m| m.contains("130%")));
    server.abort();
}

#[tokio::test]
async fn permanent_poll_errors_pause_immediately_and_submissions_are_never_reposted() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let (base, server) = server(Router::new().fallback(move |req: Request| {
        let seen = seen.clone();
        async move {
            let path = req.uri().path();
            seen.lock()
                .unwrap()
                .push((req.method().to_string(), path.to_string()));
            Response::builder()
                .status(if path.ends_with("/denied") { 401 } else { 503 })
                .body(Body::empty())
                .unwrap()
        }
    }))
    .await;
    let home = tempfile::tempdir().unwrap();
    let studio = Arc::new(studio(home.path(), |_| {}));
    for (ticket, expected, calls) in [
        (Some("denied"), "paused", 1),
        (Some("busy"), "paused", 4),
        (None, "uncertain", 1),
    ] {
        requests.lock().unwrap().clear();
        let id = id();
        let job = Job {
            id: id.clone(),
            protocol_id: "openai-video".into(),
            base_url: base.clone(),
            remote_id: ticket.map(str::to_string),
            status: if ticket.is_some() {
                "waiting"
            } else {
                "submitting"
            }
            .into(),
            ..Default::default()
        };
        studio.store.save_job(&job).unwrap();
        studio.launch(job, ticket.is_none()).unwrap();
        let saved = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let job = studio.store.job(&id).unwrap();
                if job.status == expected {
                    break job;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(saved.remote_id.as_deref(), ticket);
        let calls_seen = requests.lock().unwrap();
        assert_eq!(calls_seen.len(), calls);
        let verb = if ticket.is_some() { "GET" } else { "POST" };
        assert!(calls_seen.iter().all(|(method, _)| method == verb));
    }
    server.abort();
}
