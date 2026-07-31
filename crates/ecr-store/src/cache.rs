use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;

/// A bounded cache keyed by a file's path and mtime.
///
/// A parsed message is expensive relative to everything else in a body
/// request, and a maildir file never changes in place — a new message is a new
/// file. Keying on mtime as well means the rare rewrite still invalidates.
pub struct FileCache<T> {
    inner: Mutex<Inner<T>>,
    capacity: usize,
}

struct Inner<T> {
    entries: HashMap<String, Entry<T>>,
    /// Insertion order, oldest first, for eviction.
    order: Vec<String>,
}

struct Entry<T> {
    modified: Option<SystemTime>,
    value: T,
}

impl<T: Clone> FileCache<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                order: Vec::new(),
            }),
            capacity: capacity.max(1),
        }
    }

    pub fn get(&self, key: &str, modified: Option<SystemTime>) -> Option<T> {
        let inner = self.inner.lock().ok()?;
        let entry = inner.entries.get(key)?;

        (entry.modified == modified).then(|| entry.value.clone())
    }

    pub fn insert(&self, key: String, modified: Option<SystemTime>, value: T) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };

        if inner
            .entries
            .insert(key.clone(), Entry { modified, value })
            .is_none()
        {
            inner.order.push(key);
        }

        while inner.order.len() > self.capacity {
            let oldest = inner.order.remove(0);
            inner.entries.remove(&oldest);
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|i| i.entries.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.entries.clear();
            inner.order.clear();
        }
    }
}

pub fn modified_at(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(seconds: u64) -> Option<SystemTime> {
        Some(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
    }

    #[test]
    fn returns_what_was_stored() {
        let cache: FileCache<String> = FileCache::new(4);
        cache.insert("a".into(), at(1), "value".into());

        assert_eq!(cache.get("a", at(1)), Some("value".to_string()));
    }

    #[test]
    fn misses_on_an_unknown_key() {
        let cache: FileCache<String> = FileCache::new(4);
        assert_eq!(cache.get("nope", at(1)), None);
    }

    #[test]
    fn a_changed_mtime_invalidates_the_entry() {
        let cache: FileCache<String> = FileCache::new(4);
        cache.insert("a".into(), at(1), "old".into());

        assert_eq!(cache.get("a", at(2)), None);
    }

    #[test]
    fn a_file_that_lost_its_mtime_is_not_served_from_cache() {
        let cache: FileCache<String> = FileCache::new(4);
        cache.insert("a".into(), at(1), "value".into());

        assert_eq!(cache.get("a", None), None);
    }

    #[test]
    fn evicts_the_oldest_once_full() {
        let cache: FileCache<String> = FileCache::new(2);
        cache.insert("a".into(), at(1), "a".into());
        cache.insert("b".into(), at(1), "b".into());
        cache.insert("c".into(), at(1), "c".into());

        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("a", at(1)), None);
        assert_eq!(cache.get("c", at(1)), Some("c".to_string()));
    }

    #[test]
    fn re_inserting_a_key_does_not_grow_the_order_list() {
        let cache: FileCache<String> = FileCache::new(2);
        cache.insert("a".into(), at(1), "one".into());
        cache.insert("a".into(), at(2), "two".into());
        cache.insert("b".into(), at(1), "b".into());

        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("a", at(2)), Some("two".to_string()));
    }

    #[test]
    fn a_zero_capacity_still_holds_one_entry() {
        let cache: FileCache<String> = FileCache::new(0);
        cache.insert("a".into(), at(1), "value".into());

        assert_eq!(cache.get("a", at(1)), Some("value".to_string()));
    }

    #[test]
    fn clearing_empties_it() {
        let cache: FileCache<String> = FileCache::new(4);
        cache.insert("a".into(), at(1), "value".into());
        cache.clear();

        assert!(cache.is_empty());
    }
}
