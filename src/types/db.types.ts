export type SubscriptionStatus = 'free' | 'vip' | 'cancelled';

export interface User {
  id: string; // UUID
  telegram_id: number;
  subscription_status: SubscriptionStatus;
  stripe_customer_id?: string;
  created_at: string;
}

export interface UserFilters {
  id: string; // UUID
  user_id: string; // UUID FK
  cities_regions: string[];
  vehicle_types: string[];
  max_price: number | null;
  min_price: number | null;
  dgt_labels: string[];
  ai_preferences_summary?: string;
}

export interface AuctionVehicle {
  id: string; // Extraído del portal
  title: string;
  starting_price: number;
  market_value: number | null;
  location_region: string;
  vehicle_type: string;
  url: string;
  source: string;
  dgt_label: string | null;
  images: string[];
  created_at: string;
}

export interface MatchSent {
  id: string; // UUID
  user_id: string; // UUID FK
  auction_id: string; // FK
  sent_at: string;
}

export interface Database {
  public: {
    Tables: {
      users: {
        Row: User;
        Insert: Omit<User, 'id' | 'created_at'>;
        Update: Partial<Omit<User, 'id' | 'created_at'>>;
      };
      user_filters: {
        Row: UserFilters;
        Insert: Omit<UserFilters, 'id'>;
        Update: Partial<Omit<UserFilters, 'id'>>;
      };
      auctions_vehicles: {
        Row: AuctionVehicle;
        Insert: Omit<AuctionVehicle, 'created_at'>;
        Update: Partial<Omit<AuctionVehicle, 'created_at'>>;
      };
      matches_sent: {
        Row: MatchSent;
        Insert: Omit<MatchSent, 'id' | 'sent_at'>;
        Update: Partial<Omit<MatchSent, 'id' | 'sent_at'>>;
      };
    };
  };
}
