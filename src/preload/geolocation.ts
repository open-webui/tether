// Runs in WebUI's world so its existing browser API calls get the deadline too.
export function installGeolocationTimeout(): void {
  const geolocation = navigator.geolocation
  if (!geolocation) return
  const getCurrentPosition = geolocation.getCurrentPosition

  geolocation.getCurrentPosition = function (success, error, options): void {
    // Let Chromium validate callbacks before starting our timer.
    if (typeof success !== 'function' || (error != null && typeof error !== 'function')) {
      return getCurrentPosition.call(this, success, error, options)
    }
    const timeout = Math.max(0, Math.min(options?.timeout ?? 10_000, 10_000))
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    // Chromium's own timeout excludes waiting for permission; bound that wait as well.
    const timer = setTimeout(
      () =>
        finish(() =>
          error?.({
            code: 3,
            message: 'Location request timed out.',
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3
          })
        ),
      timeout
    )
    try {
      getCurrentPosition.call(
        this,
        (position) => finish(() => success(position)),
        (cause) => finish(() => error?.(cause)),
        { ...options, timeout }
      )
    } catch (cause) {
      settled = true
      clearTimeout(timer)
      throw cause
    }
  }
}
