package main

import (
	"context"
	"time"
)

func (s *server) runRestaurantStockExpiry(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			jobCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			_, err := s.orders.ExpireStockReservations(jobCtx, 50)
			cancel()
			if err != nil && ctx.Err() == nil {
				s.log.Warn("stock reservation expiry deferred")
			}
		}
	}
}
