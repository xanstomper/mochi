package message

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mochi/mochi/internal/db"
	"github.com/mochi/mochi/internal/pubsub"
	"github.com/mochi/mochi/internal/session"
	"github.com/stretchr/testify/require"
)

// newTestService spins up a fresh in-memory message.Service and a test
// session. Returns the service plus a session ID.
func newTestService(t *testing.T) (Service, string) {
	t.Helper()
	conn, err := db.Connect(t.Context(), t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	q := db.New(conn)
	sessions := session.NewService(q, conn)
	sess, err := sessions.Create(t.Context(), "test")
	require.NoError(t, err)

	svc := NewService()
	return svc, sess.ID
}

// eventCollector consumes broker events into a slice in a goroutine
// and exposes thread-safe Snapshot / Reset helpers for assertions.
type eventCollector struct {
	mu     sync.Mutex
	events []pubsub.Event[Message]
}

func collect(ctx context.Context, sub <-chan pubsub.Event[Message]) *eventCollector {
	c := &eventCollector{}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-sub:
				if !ok {
					return
				}
				c.mu.Lock()
				c.events = append(c.events, ev)
				c.mu.Unlock()
			}
		}
	}()
	return c
}

func (c *eventCollector) snapshot() []pubsub.Event[Message] {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]pubsub.Event[Message], len(c.events))
	copy(out, c.events)
	return out
}

func (c *eventCollector) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = nil
}

func TestCreateAndGet(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{
		Role: Assistant,
		Parts: []ContentPart{
			TextContent{Text: "hello"},
		},
	})
	require.NoError(t, err)
	require.NotEmpty(t, msg.ID)
	require.Equal(t, Assistant, msg.Role)
	require.Equal(t, "hello", msg.Content().Text)

	got, err := svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	require.Equal(t, msg.ID, got.ID)
	require.Equal(t, "hello", got.Content().Text)
}

func TestCreate_Defaults(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)
	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: User})
	require.NoError(t, err)
	require.NotEmpty(t, msg.ID)
	require.Equal(t, sessionID, msg.SessionID)
	require.NotZero(t, msg.CreatedAt)
	require.NotZero(t, msg.UpdatedAt)
}

func TestGet_NotFound(t *testing.T) {
	t.Parallel()

	svc, _ := newTestService(t)
	_, err := svc.Get(t.Context(), "nonexistent")
	require.Error(t, err)
}

func TestUpdate(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)

	msg.AppendContent(" world")
	require.NoError(t, svc.Update(t.Context(), msg))

	got, err := svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	require.Equal(t, " world", got.Content().Text)
}

func TestUpdate_ToolCalls(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)

	msg.AddToolCall(ToolCall{ID: "tc1", Name: "view"})
	require.NoError(t, svc.Update(t.Context(), msg))

	got, err := svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	require.Len(t, got.ToolCalls(), 1)
	require.Equal(t, "tc1", got.ToolCalls()[0].ID)

	msg.AddToolCall(ToolCall{ID: "tc1", Name: "view", Input: "{}", Finished: true})
	require.NoError(t, svc.Update(t.Context(), msg))

	got, err = svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	require.True(t, got.ToolCalls()[0].Finished)
}

func TestUpdate_Reasoning(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)

	msg.AppendReasoningContent("thinking...")
	require.NoError(t, svc.Update(t.Context(), msg))

	got, err := svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	require.Equal(t, "thinking...", got.ReasoningContent().Thinking)

	msg.FinishThinking()
	require.NoError(t, svc.Update(t.Context(), msg))

	got, err = svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	require.Equal(t, "thinking...", got.ReasoningContent().Thinking)
	require.NotZero(t, got.ReasoningContent().FinishedAt)
}

func TestUpdate_FinalContent(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)

	msg.AppendContent("final")
	msg.AddFinish(FinishReasonEndTurn, "", "")
	require.NoError(t, svc.Update(t.Context(), msg))

	got, err := svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	require.Equal(t, "final", got.Content().Text)
	require.True(t, got.IsFinished())
}

func TestList(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	for range 3 {
		_, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
		require.NoError(t, err)
	}

	msgs, err := svc.List(t.Context(), sessionID)
	require.NoError(t, err)
	require.Len(t, msgs, 3)
}

func TestList_EmptySession(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msgs, err := svc.List(t.Context(), sessionID)
	require.NoError(t, err)
	require.Empty(t, msgs)
}

func TestListUserMessages(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	_, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: User, Parts: []ContentPart{TextContent{Text: "hello"}}})
	require.NoError(t, err)
	_, err = svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)

	msgs, err := svc.ListUserMessages(t.Context(), sessionID)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	require.Equal(t, User, msgs[0].Role)
}

func TestDelete(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: User})
	require.NoError(t, err)

	require.NoError(t, svc.Delete(t.Context(), msg.ID))

	_, err = svc.Get(t.Context(), msg.ID)
	require.Error(t, err)

	msgs, err := svc.List(t.Context(), sessionID)
	require.NoError(t, err)
	require.Empty(t, msgs)
}

func TestDeleteSession(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	for range 3 {
		_, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: User})
		require.NoError(t, err)
	}

	require.NoError(t, svc.DeleteSession(t.Context(), sessionID))

	msgs, err := svc.List(t.Context(), sessionID)
	require.NoError(t, err)
	require.Empty(t, msgs)
}

func TestSubscribe_ReceivesCreateEvents(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	subCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	sub := svc.Subscribe(subCtx)
	collector := collect(subCtx, sub)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		events := collector.snapshot()
		if len(events) < 1 {
			return false
		}
		return events[0].Type == pubsub.CreatedEvent && events[0].Payload.ID == msg.ID
	}, time.Second, 5*time.Millisecond)
}

func TestSubscribe_ReceivesUpdateEvents(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)

	subCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	sub := svc.Subscribe(subCtx)
	collector := collect(subCtx, sub)

	msg.AppendContent("updated")
	require.NoError(t, svc.Update(t.Context(), msg))

	require.Eventually(t, func() bool {
		events := collector.snapshot()
		if len(events) < 1 {
			return false
		}
		return events[0].Type == pubsub.UpdatedEvent && events[0].Payload.Content().Text == "updated"
	}, time.Second, 5*time.Millisecond)
}

func TestSubscribe_ReceivesDeleteEvents(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: User})
	require.NoError(t, err)

	subCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	sub := svc.Subscribe(subCtx)
	collector := collect(subCtx, sub)

	require.NoError(t, svc.Delete(t.Context(), msg.ID))

	require.Eventually(t, func() bool {
		events := collector.snapshot()
		if len(events) < 1 {
			return false
		}
		return events[0].Type == pubsub.DeletedEvent
	}, time.Second, 5*time.Millisecond)
}

func TestFlushAll(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)
	msg.AppendContent("buffered")
	require.NoError(t, svc.Update(t.Context(), msg))

	require.NoError(t, svc.FlushAll(t.Context()))

	got, err := svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	require.Equal(t, "buffered", got.Content().Text)
}

func TestListOrdering(t *testing.T) {
	t.Parallel()

	svc, sessionID := newTestService(t)

	msgs := make([]Message, 3)
	for i := range msgs {
		m, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: User})
		require.NoError(t, err)
		msgs[i] = m
	}

	listed, err := svc.List(t.Context(), sessionID)
	require.NoError(t, err)
	require.Len(t, listed, 3)

	// Messages should be in creation order (FIFO).
	for i, m := range msgs {
		require.Equal(t, m.ID, listed[i].ID)
	}
}

func TestParallelWrites(t *testing.T) {
	svc, sessionID := newTestService(t)

	msg, err := svc.Create(t.Context(), sessionID, CreateMessageParams{Role: Assistant})
	require.NoError(t, err)

	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m := msg
			m.AppendContent("x")
			_ = svc.Update(t.Context(), m)
		}()
	}
	wg.Wait()

	got, err := svc.Get(t.Context(), msg.ID)
	require.NoError(t, err)
	// At least one "x" should have been appended safely under concurrent writes.
	require.Contains(t, got.Content().Text, "x")
}

// --- PubSub Broker unit tests (independent of message.Service) ---

func TestBroker_PublishLossyDropCounter(t *testing.T) {
	t.Parallel()

	b := pubsub.NewBrokerWithOptions[int](1)
	defer b.Shutdown()

	subCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	sub := b.Subscribe(subCtx)
	require.NotNil(t, sub)

	for range 100 {
		b.Publish(pubsub.UpdatedEvent, 1)
	}

	require.GreaterOrEqual(t, b.DropCount(), uint64(1),
		"lossy Publish must increment the drop counter under contention")
}

func TestBroker_PublishMustDeliverHonorsTimeout(t *testing.T) {
	t.Parallel()

	b := pubsub.NewBrokerWithOptions[int](1)
	b.SetMustDeliverTimeout(20 * time.Millisecond)
	defer b.Shutdown()

	subCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	sub := b.Subscribe(subCtx)
	require.NotNil(t, sub)

	b.Publish(pubsub.UpdatedEvent, 1)

	start := time.Now()
	b.PublishMustDeliver(t.Context(), pubsub.UpdatedEvent, 2)
	elapsed := time.Since(start)

	require.GreaterOrEqual(t, elapsed, 20*time.Millisecond,
		"PublishMustDeliver should block at least the timeout under contention")
	require.Less(t, elapsed, 200*time.Millisecond,
		"PublishMustDeliver must not block indefinitely")
	require.GreaterOrEqual(t, b.MustDeliverDropCount(), uint64(1),
		"timeout must increment the must-deliver drop counter")
}

func TestBroker_PublishMustDeliverWithReader(t *testing.T) {
	t.Parallel()

	b := pubsub.NewBrokerWithOptions[int](1)
	b.SetMustDeliverTimeout(50 * time.Millisecond)
	defer b.Shutdown()

	subCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	sub := b.Subscribe(subCtx)

	var received atomic.Uint64
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-subCtx.Done():
				return
			case _, ok := <-sub:
				if !ok {
					return
				}
				received.Add(1)
			}
		}
	}()

	for i := range 10 {
		b.PublishMustDeliver(t.Context(), pubsub.UpdatedEvent, i)
	}

	require.Eventually(t, func() bool { return received.Load() == 10 },
		time.Second, 5*time.Millisecond,
		"all must-deliver events should reach an active subscriber")
	require.Zero(t, b.MustDeliverDropCount(),
		"no drops expected when subscriber drains promptly")
}
