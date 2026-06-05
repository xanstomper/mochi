package message

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/mochi/mochi/internal/pubsub"
)

// CreateMessageParams is the input to Service.Create.
type CreateMessageParams struct {
	Role             MessageRole
	Parts            []ContentPart
	Model            string
	Provider         string
	IsSummaryMessage bool
}

// Service is the message storage interface used by the agent.
type Service interface {
	Create(ctx context.Context, sessionID string, params CreateMessageParams) (Message, error)
	Get(ctx context.Context, id string) (Message, error)
	List(ctx context.Context, sessionID string) ([]Message, error)
	ListUserMessages(ctx context.Context, sessionID string) ([]Message, error)
	ListAllUserMessages(ctx context.Context) ([]Message, error)
	Update(ctx context.Context, message Message) error
	Delete(ctx context.Context, id string) error
	DeleteSession(ctx context.Context, sessionID string) error
	Subscribe(ctx context.Context) <-chan pubsub.Event[Message]
	FlushAll(ctx context.Context) error
}

// MemService is an in-memory implementation of Service suitable for
// the in-process app and for tests.
type MemService struct {
	mu       sync.RWMutex
	messages map[string]Message
	sessions map[string][]string
	broker   *pubsub.Broker[Message]
}

func NewService() *MemService {
	return &MemService{
		messages: make(map[string]Message),
		sessions: make(map[string][]string),
		broker:   pubsub.NewBroker[Message](),
	}
}

func (s *MemService) Create(ctx context.Context, sessionID string, params CreateMessageParams) (Message, error) {
	s.mu.Lock()
	now := time.Now().UnixMilli()
	msg := Message{
		ID:               uuid.NewString(),
		SessionID:        sessionID,
		Role:             params.Role,
		Parts:            params.Parts,
		Model:            params.Model,
		Provider:         params.Provider,
		CreatedAt:        now,
		UpdatedAt:        now,
		IsSummaryMessage: params.IsSummaryMessage,
	}
	s.messages[msg.ID] = msg
	s.sessions[sessionID] = append(s.sessions[sessionID], msg.ID)
	s.mu.Unlock()
	s.broker.Publish(pubsub.EventType(sessionID), msg)
	return msg, nil
}

func (s *MemService) Get(ctx context.Context, id string) (Message, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.messages[id]
	if !ok {
		return Message{}, errNotFound(id)
	}
	return m, nil
}

func (s *MemService) List(ctx context.Context, sessionID string) ([]Message, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := s.sessions[sessionID]
	out := make([]Message, 0, len(ids))
	for _, id := range ids {
		if m, ok := s.messages[id]; ok {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

func (s *MemService) ListUserMessages(ctx context.Context, sessionID string) ([]Message, error) {
	all, err := s.List(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(all))
	for _, m := range all {
		if m.Role == User {
			out = append(out, m)
		}
	}
	return out, nil
}

func (s *MemService) ListAllUserMessages(ctx context.Context) ([]Message, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Message, 0)
	for _, m := range s.messages {
		if m.Role == User {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

func (s *MemService) Update(ctx context.Context, m Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.messages[m.ID]; !ok {
		return errNotFound(m.ID)
	}
	m.UpdatedAt = time.Now().UnixMilli()
	s.messages[m.ID] = m
	return nil
}

func (s *MemService) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.messages[id]
	if !ok {
		return errNotFound(id)
	}
	delete(s.messages, id)
	ids := s.sessions[m.SessionID]
	for i, x := range ids {
		if x == id {
			s.sessions[m.SessionID] = append(ids[:i], ids[i+1:]...)
			break
		}
	}
	return nil
}

func (s *MemService) DeleteSession(ctx context.Context, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range s.sessions[sessionID] {
		delete(s.messages, id)
	}
	delete(s.sessions, sessionID)
	return nil
}

func (s *MemService) Subscribe(ctx context.Context) <-chan pubsub.Event[Message] {
	return s.broker.Subscribe(ctx)
}

func (s *MemService) FlushAll(ctx context.Context) error {
	s.broker.PublishMustDeliver(ctx, pubsub.EventType("flush"), Message{})
	return nil
}

type notFoundErr string

func (e notFoundErr) Error() string { return "message not found: " + string(e) }

func errNotFound(id string) error { return notFoundErr(id) }
