use chrono::Utc;
use parking_lot::Mutex;
use serde::Serialize;
use std::{sync::Arc, time::Duration, time::Instant};

const DEFAULT_RSS_TTL: Duration = Duration::from_millis(500);

type RssReader = dyn Fn() -> Result<u64, String> + Send + Sync;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssSample {
    pub rss_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rss_unavailable_reason: Option<String>,
    pub captured_at_unix_ms: i64,
}

struct CachedRssSample {
    sampled_at: Instant,
    sample: RssSample,
}

pub struct RssSampler {
    ttl: Duration,
    cache: Mutex<Option<CachedRssSample>>,
    reader: Box<RssReader>,
}

impl RssSampler {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            ttl: DEFAULT_RSS_TTL,
            cache: Mutex::new(None),
            reader: Box::new(read_process_rss_bytes),
        })
    }

    #[cfg(test)]
    pub fn with_reader(ttl: Duration, reader: Box<RssReader>) -> Self {
        Self {
            ttl,
            cache: Mutex::new(None),
            reader,
        }
    }

    pub fn sample(&self) -> RssSample {
        let now = Instant::now();
        if let Some(cached) = self.cache.lock().as_ref()
            && now.duration_since(cached.sampled_at) <= self.ttl
        {
            return cached.sample.clone();
        }

        let sample = match (self.reader)() {
            Ok(bytes) => RssSample {
                rss_bytes: Some(bytes),
                rss_unavailable_reason: None,
                captured_at_unix_ms: Utc::now().timestamp_millis(),
            },
            Err(reason) => RssSample {
                rss_bytes: None,
                rss_unavailable_reason: Some(reason),
                captured_at_unix_ms: Utc::now().timestamp_millis(),
            },
        };
        *self.cache.lock() = Some(CachedRssSample {
            sampled_at: now,
            sample: sample.clone(),
        });
        sample
    }
}

#[cfg(target_os = "linux")]
fn read_process_rss_bytes() -> Result<u64, String> {
    let statm =
        std::fs::read_to_string("/proc/self/statm").map_err(|err| format!("read statm: {err}"))?;
    let resident_pages = statm
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "statm missing resident page count".to_string())?
        .parse::<u64>()
        .map_err(|err| format!("parse statm resident pages: {err}"))?;
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return Err("sysconf(_SC_PAGESIZE) returned non-positive page size".into());
    }
    resident_pages
        .checked_mul(page_size as u64)
        .ok_or_else(|| "rss byte count overflowed u64".to_string())
}

#[cfg(target_os = "macos")]
fn read_process_rss_bytes() -> Result<u64, String> {
    let mut info = std::mem::MaybeUninit::<libc::mach_task_basic_info_data_t>::uninit();
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    #[allow(deprecated)]
    let task = unsafe { libc::mach_task_self() };
    let status = unsafe {
        libc::task_info(
            task,
            libc::MACH_TASK_BASIC_INFO,
            info.as_mut_ptr().cast(),
            &mut count,
        )
    };
    if status != libc::KERN_SUCCESS {
        return Err(format!("task_info(MACH_TASK_BASIC_INFO) failed: {status}"));
    }
    let info = unsafe { info.assume_init() };
    Ok(info.resident_size as u64)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_process_rss_bytes() -> Result<u64, String> {
    Err(format!(
        "process rss is unsupported on {}",
        std::env::consts::OS
    ))
}

#[cfg(test)]
mod tests {
    use super::RssSampler;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    #[test]
    fn rss_sampler_caches_samples_within_ttl() {
        let calls = Arc::new(AtomicUsize::new(0));
        let reader_calls = Arc::clone(&calls);
        let sampler = RssSampler::with_reader(
            Duration::from_secs(60),
            Box::new(move || {
                reader_calls.fetch_add(1, Ordering::SeqCst);
                Ok(42)
            }),
        );

        assert_eq!(sampler.sample().rss_bytes, Some(42));
        assert_eq!(sampler.sample().rss_bytes, Some(42));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn rss_sampler_surfaces_unavailable_reason() {
        let sampler = RssSampler::with_reader(
            Duration::from_secs(60),
            Box::new(|| Err("unsupported test platform".into())),
        );

        let sample = sampler.sample();
        assert_eq!(sample.rss_bytes, None);
        assert_eq!(
            sample.rss_unavailable_reason.as_deref(),
            Some("unsupported test platform")
        );
    }
}
