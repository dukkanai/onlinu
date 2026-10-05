package main

import "context"

type restaurantMenuTargetKey struct{}
type restaurantMenuTarget struct{ Kind, ID string }

type restaurantMenuItemSummary struct {
	ID         string `json:"id"`
	CategoryID string `json:"categoryId"`
	Name       string `json:"name"`
	PriceMinor int64  `json:"priceMinor"`
	Available  bool   `json:"available"`
	Sort       int    `json:"sort"`
}
type restaurantStaffMenu struct {
	Version    int64                       `json:"version"`
	Name       string                      `json:"name"`
	Currency   string                      `json:"currency"`
	Categories []restaurantCategory        `json:"categories"`
	Items      []restaurantMenuItemSummary `json:"items"`
}
type restaurantStaffMenuItem struct {
	Version    int64                `json:"version"`
	Currency   string               `json:"currency"`
	Categories []restaurantCategory `json:"categories"`
	Item       restaurantItem       `json:"item"`
}
type restaurantMenuItemPatch struct {
	ExpectedVersion int64               `json:"expectedVersion"`
	Name            *string             `json:"name"`
	CategoryID      *string             `json:"categoryId"`
	Description     *string             `json:"description"`
	PriceMinor      *int64              `json:"priceMinor"`
	ImageURL        *string             `json:"imageUrl"`
	Available       *bool               `json:"available"`
	Sort            *int                `json:"sort"`
	Options         *[]restaurantOption `json:"options"`
}

func (s *restaurantStore) StaffMenu(ctx context.Context) (restaurantStaffMenu, error) {
	catalog, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffMenu{}, err
	}
	items := make([]restaurantMenuItemSummary, 0, len(catalog.Items))
	for _, item := range catalog.Items {
		items = append(items, restaurantMenuItemSummary{item.ID, item.CategoryID, item.Name, item.PriceMinor, item.Available, item.Sort})
	}
	return restaurantStaffMenu{catalog.Version, catalog.Settings.Name, catalog.Settings.Currency, catalog.Categories, items}, nil
}
func restaurantStaffMenuItemView(catalog restaurantCatalog, id string) (restaurantStaffMenuItem, error) {
	for _, item := range catalog.Items {
		if item.ID == id {
			return restaurantStaffMenuItem{catalog.Version, catalog.Settings.Currency, catalog.Categories, item}, nil
		}
	}
	return restaurantStaffMenuItem{}, restaurantFail(404, "item_unavailable")
}
func (s *restaurantStore) StaffMenuItem(ctx context.Context, id string) (restaurantStaffMenuItem, error) {
	catalog, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffMenuItem{}, err
	}
	return restaurantStaffMenuItemView(catalog, id)
}
func (s *restaurantStore) PatchMenuItem(ctx context.Context, id string, patch restaurantMenuItemPatch) (restaurantStaffMenuItem, error) {
	if patch.ExpectedVersion < 1 || patch.Name == nil && patch.CategoryID == nil && patch.Description == nil && patch.PriceMinor == nil && patch.ImageURL == nil && patch.Available == nil && patch.Sort == nil && patch.Options == nil {
		return restaurantStaffMenuItem{}, restaurantFail(400, "invalid_request")
	}
	catalog, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffMenuItem{}, err
	}
	if catalog.Version != patch.ExpectedVersion {
		return restaurantStaffMenuItem{}, restaurantFail(409, "catalog_changed")
	}
	found := false
	for i := range catalog.Items {
		item := &catalog.Items[i]
		if item.ID != id {
			continue
		}
		found = true
		if patch.Name != nil {
			item.Name = *patch.Name
		}
		if patch.CategoryID != nil {
			item.CategoryID = *patch.CategoryID
		}
		if patch.Description != nil {
			item.Description = *patch.Description
		}
		if patch.PriceMinor != nil {
			item.PriceMinor = *patch.PriceMinor
		}
		if patch.ImageURL != nil {
			item.ImageURL = *patch.ImageURL
		}
		if patch.Available != nil {
			item.Available = *patch.Available
		}
		if patch.Sort != nil {
			item.Sort = *patch.Sort
		}
		if patch.Options != nil {
			item.Options = *patch.Options
		}
		break
	}
	if !found {
		return restaurantStaffMenuItem{}, restaurantFail(404, "item_unavailable")
	}
	// SaveCatalog rechecks this version under its existing row lock. A concurrent
	// settings/table/brand update cannot be silently overwritten by this merge.
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{"item_update", id})
	saved, err := s.SaveCatalog(ctx, catalog)
	if err != nil {
		return restaurantStaffMenuItem{}, err
	}
	return restaurantStaffMenuItemView(saved, id)
}

type restaurantMenuItemCreate struct {
	ExpectedVersion int64          `json:"expectedVersion"`
	Item            restaurantItem `json:"item"`
}
type restaurantMenuCategoryCreate struct {
	ExpectedVersion int64              `json:"expectedVersion"`
	Category        restaurantCategory `json:"category"`
}
type restaurantStaffMenuCategory struct {
	Version  int64              `json:"version"`
	Category restaurantCategory `json:"category"`
}

func (s *restaurantStore) CreateMenuItem(ctx context.Context, input restaurantMenuItemCreate) (restaurantStaffMenuItem, error) {
	catalog, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffMenuItem{}, err
	}
	if input.ExpectedVersion < 1 {
		return restaurantStaffMenuItem{}, restaurantFail(400, "invalid_request")
	}
	if catalog.Version != input.ExpectedVersion {
		return restaurantStaffMenuItem{}, restaurantFail(409, "catalog_changed")
	}
	for _, item := range catalog.Items {
		if item.ID == input.Item.ID {
			return restaurantStaffMenuItem{}, restaurantFail(409, "conflict")
		}
	}
	catalog.Items = append(catalog.Items, input.Item)
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{"item_create", input.Item.ID})
	saved, err := s.SaveCatalog(ctx, catalog)
	if err != nil {
		return restaurantStaffMenuItem{}, err
	}
	return restaurantStaffMenuItemView(saved, input.Item.ID)
}
func (s *restaurantStore) CreateMenuCategory(ctx context.Context, input restaurantMenuCategoryCreate) (restaurantStaffMenuCategory, error) {
	catalog, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffMenuCategory{}, err
	}
	if input.ExpectedVersion < 1 {
		return restaurantStaffMenuCategory{}, restaurantFail(400, "invalid_request")
	}
	if catalog.Version != input.ExpectedVersion {
		return restaurantStaffMenuCategory{}, restaurantFail(409, "catalog_changed")
	}
	for _, category := range catalog.Categories {
		if category.ID == input.Category.ID {
			return restaurantStaffMenuCategory{}, restaurantFail(409, "conflict")
		}
	}
	catalog.Categories = append(catalog.Categories, input.Category)
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{"category_create", input.Category.ID})
	saved, err := s.SaveCatalog(ctx, catalog)
	if err != nil {
		return restaurantStaffMenuCategory{}, err
	}
	for _, category := range saved.Categories {
		if category.ID == input.Category.ID {
			return restaurantStaffMenuCategory{saved.Version, category}, nil
		}
	}
	return restaurantStaffMenuCategory{}, restaurantFail(409, "catalog_changed")
}
