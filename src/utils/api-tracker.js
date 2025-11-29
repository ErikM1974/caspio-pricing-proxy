// Simple API call tracker to monitor Caspio API usage
// Tracks calls, endpoints, and provides metrics to stay under 500K/month limit

class APITracker {
  constructor() {
    this.calls = [];
    this.stats = {
      totalCalls: 0,
      callsByEndpoint: new Map(),
      callsByTable: new Map(),
      callsByHour: new Map(),
      callsByDay: new Map()
    };

    // Cleanup old entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Track a single API call
   */
  trackCall(endpoint, table, method = 'GET', metadata = {}) {
    const timestamp = Date.now();
    const call = {
      timestamp,
      endpoint,
      table,
      method,
      ...metadata
    };

    // Store call (keep last 24 hours in memory)
    this.calls.push(call);
    this.stats.totalCalls++;

    // Update endpoint stats
    const endpointCount = this.stats.callsByEndpoint.get(endpoint) || 0;
    this.stats.callsByEndpoint.set(endpoint, endpointCount + 1);

    // Update table stats
    const tableCount = this.stats.callsByTable.get(table) || 0;
    this.stats.callsByTable.set(table, tableCount + 1);

    // Update hourly stats
    const hour = new Date(timestamp).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const hourCount = this.stats.callsByHour.get(hour) || 0;
    this.stats.callsByHour.set(hour, hourCount + 1);

    // Update daily stats
    const day = new Date(timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
    const dayCount = this.stats.callsByDay.get(day) || 0;
    this.stats.callsByDay.set(day, dayCount + 1);

    // Log to console for immediate visibility
    console.log(`[API TRACKER] ${method} ${table} - Total today: ${this.getTodayCount()}`);
  }

  /**
   * Get call count for today
   */
  getTodayCount() {
    const today = new Date().toISOString().slice(0, 10);
    return this.stats.callsByDay.get(today) || 0;
  }

  /**
   * Get call count for last 24 hours
   */
  get24HourCount() {
    const now = Date.now();
    const last24h = now - (24 * 60 * 60 * 1000);
    return this.calls.filter(call => call.timestamp > last24h).length;
  }

  /**
   * Get monthly projection based on current pace
   */
  getMonthlyProjection() {
    const todayCount = this.getTodayCount();
    const avgDailyRate = this.get24HourCount(); // More accurate than just today
    const daysInMonth = 30;
    return Math.round(avgDailyRate * daysInMonth);
  }

  /**
   * Get top N endpoints by call count
   */
  getTopEndpoints(limit = 10) {
    return Array.from(this.stats.callsByEndpoint.entries())
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Get top N tables by call count
   */
  getTopTables(limit = 10) {
    return Array.from(this.stats.callsByTable.entries())
      .map(([table, count]) => ({ table, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Get summary metrics
   */
  getSummary() {
    const todayCount = this.getTodayCount();
    const last24h = this.get24HourCount();
    const monthlyProjection = this.getMonthlyProjection();
    const monthlyLimit = 500000;
    const percentOfLimit = Math.round((monthlyProjection / monthlyLimit) * 100);

    return {
      todayCount,
      last24hCount: last24h,
      monthlyProjection,
      monthlyLimit,
      percentOfLimit,
      status: percentOfLimit > 100 ? 'OVER_LIMIT' : percentOfLimit > 90 ? 'CRITICAL' : percentOfLimit > 80 ? 'WARNING' : 'OK',
      topEndpoints: this.getTopEndpoints(5),
      topTables: this.getTopTables(5)
    };
  }

  /**
   * Cleanup old entries (keep last 24 hours)
   */
  cleanup() {
    const now = Date.now();
    const cutoff = now - (24 * 60 * 60 * 1000);

    const beforeCount = this.calls.length;
    this.calls = this.calls.filter(call => call.timestamp > cutoff);
    const afterCount = this.calls.length;

    if (beforeCount > afterCount) {
      console.log(`[API TRACKER] Cleaned up ${beforeCount - afterCount} old entries. Kept ${afterCount} entries from last 24h.`);
    }

    // Cleanup hourly stats (keep last 48 hours)
    const hourCutoff = new Date(now - (48 * 60 * 60 * 1000)).toISOString().slice(0, 13);
    for (const [hour] of this.stats.callsByHour.entries()) {
      if (hour < hourCutoff) {
        this.stats.callsByHour.delete(hour);
      }
    }

    // Cleanup daily stats (keep last 30 days)
    const dayCutoff = new Date(now - (30 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    for (const [day] of this.stats.callsByDay.entries()) {
      if (day < dayCutoff) {
        this.stats.callsByDay.delete(day);
      }
    }
  }

  /**
   * Reset all stats (for testing)
   */
  reset() {
    this.calls = [];
    this.stats = {
      totalCalls: 0,
      callsByEndpoint: new Map(),
      callsByTable: new Map(),
      callsByHour: new Map(),
      callsByDay: new Map()
    };
    console.log('[API TRACKER] Stats reset');
  }
}

// Singleton instance
const tracker = new APITracker();

module.exports = tracker;
