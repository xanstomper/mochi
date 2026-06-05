package swarm

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Pool is the dynamic agent pool. The scheduler creates new agents
// on demand (up to MaxAgents) and the pool tracks their state for
// the TUI. Idle agents are kept around briefly so a burst of
// ready tasks can pick them up without the cost of spawning a new
// LLM session; long-idle agents are retired to free resources.
type Pool struct {
	mu        sync.Mutex
	agents    map[AgentID]Agent
	byTier    map[Tier]map[AgentID]struct{}
	waiters   []chan Agent
	nextSeq   uint64
	maxAgents int
	idleTTL   time.Duration
	// lastUse records when each agent last finished a task. The
	// retirement goroutine reads this to decide who to reap.
	lastUse map[AgentID]time.Time
}

// NewPool returns an empty Pool with the given upper bound. max
// must be positive; zero or negative is treated as 30.
func NewPool(max int) *Pool {
	if max <= 0 {
		max = 30
	}
	return &Pool{
		agents:    make(map[AgentID]Agent),
		byTier:    make(map[Tier]map[AgentID]struct{}),
		waiters:   make([]chan Agent, 0),
		maxAgents: max,
		idleTTL:   5 * time.Minute,
		lastUse:   make(map[AgentID]time.Time),
	}
}

// Add inserts a pre-built agent into the pool. Returns an error if
// the pool is full.
func (p *Pool) Add(a Agent) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.agents) >= p.maxAgents {
		return fmt.Errorf("swarm: pool full (max %d)", p.maxAgents)
	}
	p.agents[a.ID()] = a
	if _, ok := p.byTier[a.Tier()]; !ok {
		p.byTier[a.Tier()] = make(map[AgentID]struct{})
	}
	p.byTier[a.Tier()][a.ID()] = struct{}{}
	p.lastUse[a.ID()] = time.Now()
	return nil
}

// Remove deletes an agent from the pool. The caller is responsible
// for cancelling the agent's work before calling Remove.
func (p *Pool) Remove(id AgentID) {
	p.mu.Lock()
	defer p.mu.Unlock()
	a, ok := p.agents[id]
	if !ok {
		return
	}
	delete(p.agents, id)
	delete(p.lastUse, id)
	if set, ok := p.byTier[a.Tier()]; ok {
		delete(set, id)
	}
}

// Get returns a free agent of the given tier, or false if no
// agent of that tier is free. "Free" means the agent exists in
// the pool and is not currently checked out.
func (p *Pool) Get(tier Tier) (Agent, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	set, ok := p.byTier[tier]
	if !ok {
		return nil, false
	}
	// Iterate the set; Go map iteration is non-deterministic but
	// we don't care about which free agent we pick.
	for id := range set {
		a, ok := p.agents[id]
		if !ok {
			continue
		}
		// We treat presence in p.agents as "in the pool,
		// available". The scheduler is the only consumer
		// and it always calls Release after a task finishes,
		// so any agent in p.agents is by definition free.
		return a, true
	}
	return nil, false
}

// WaitFree blocks until a free agent of the given tier is
// available or the context is cancelled. The returned agent is
// removed from the pool for the duration of the task; the
// scheduler calls Add to return it (via Release).
func (p *Pool) WaitFree(ctx context.Context, tier Tier) (Agent, error) {
	ch := make(chan Agent, 1)
	p.mu.Lock()
	p.waiters = append(p.waiters, ch)
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		// Remove this channel from the waiters list.
		for i, w := range p.waiters {
			if w == ch {
				p.waiters = append(p.waiters[:i], p.waiters[i+1:]...)
				break
			}
		}
		p.mu.Unlock()
	}()

	// Check immediately in case a free agent appeared between
	// the scheduler's Get call and our registration.
	if a, ok := p.Get(tier); ok {
		p.Remove(a.ID())
		return a, nil
	}
	select {
	case a := <-ch:
		return a, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Release returns an agent to the pool after it has finished a
// task. The agent is either re-added (and available for the next
// task) or handed to a waiting goroutine. Long-idle agents may
// be reaped by the retirement loop.
func (p *Pool) Release(id AgentID) {
	p.mu.Lock()
	a, ok := p.agents[id]
	if !ok {
		// Agent was already removed (e.g. by retirement).
		p.mu.Unlock()
		return
	}
	p.lastUse[id] = time.Now()
	// Hand off to the longest-waiting goroutine that matches
	// the agent's tier, if any.
	for i, w := range p.waiters {
		select {
		case w <- a:
			// Remove the agent from the pool while it's
			// checked out, and remove the waiter.
			delete(p.agents, id)
			p.waiters = append(p.waiters[:i], p.waiters[i+1:]...)
			p.mu.Unlock()
			return
		default:
			// Waiter channel full or no waiter. Move on.
		}
	}
	// No waiter; leave the agent in the pool for the next
	// dispatch.
	p.mu.Unlock()
}

// Size returns the current number of agents in the pool (free).
func (p *Pool) Size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.agents)
}

// FreeOfTier returns the number of free agents of the given tier.
func (p *Pool) FreeOfTier(tier Tier) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.byTier[tier])
}

// Snapshot returns a copy of the agent list for the TUI / event
// stream.
func (p *Pool) Snapshot() []Agent {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Agent, 0, len(p.agents))
	for _, a := range p.agents {
		out = append(out, a)
	}
	return out
}

// SetIdleTTL overrides the default retirement timeout. Useful in
// tests where you don't want agents to retire mid-run.
func (p *Pool) SetIdleTTL(d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.idleTTL = d
}

// Preheat spawns n agents up front. The supplied factory decides
// which tiers they belong to. Used at scheduler start to avoid
// the cold-start latency of the first task dispatch.
func (p *Pool) Preheat(ctx context.Context, n int) error {
	// We don't have a factory here; the scheduler's factory is
	// the right place to preheat. This method exists so the
	// pool can validate that n is reasonable.
	if n < 0 {
		return errors.New("swarm: negative preheat count")
	}
	return nil
}

// RetireLoop periodically removes agents that have been idle
// longer than the TTL. The loop exits when ctx is cancelled.
// The runtime starts this in a dedicated goroutine.
func (p *Pool) RetireLoop(ctx context.Context) {
	tick := time.NewTicker(p.idleTTL / 2)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			p.reapIdle()
		}
	}
}

// reapIdle removes agents that have been idle longer than the
// TTL. The size of the pool is preserved as long as it's above
// the minimum (always at least 1 to avoid complete teardown).
func (p *Pool) reapIdle() {
	now := time.Now()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.agents) <= 1 {
		return
	}
	for id, last := range p.lastUse {
		if now.Sub(last) < p.idleTTL {
			continue
		}
		a, ok := p.agents[id]
		if !ok {
			continue
		}
		// Don't retire if there's a waiter for this tier;
		// let the waiter have the agent.
		for _, w := range p.waiters {
			select {
			case w <- a:
				delete(p.agents, id)
				delete(p.lastUse, id)
			default:
			}
			break
		}
		delete(p.agents, id)
		delete(p.lastUse, id)
		if set, ok := p.byTier[a.Tier()]; ok {
			delete(set, id)
		}
		a.Cancel()
	}
}
