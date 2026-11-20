import axios, { AxiosInstance } from 'axios';

export interface UserProfile {
  id: number;
  name: string;
  email: string;
  role: 'sales' | 'purchasing';
}

export interface ErpAuthResponse {
  token: string;
  user: UserProfile;
}

export class ErpClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.LARAVEL_API_URL || 'http://localhost:8000';
  }

  private client(token?: string): AxiosInstance {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return axios.create({
      baseURL: this.baseUrl,
      headers,
      timeout: 10000,
    });
  }

  async login(email: string, password: string): Promise<ErpAuthResponse> {
    const response = await this.client().post('/api/login', { email, password });
    return response.data;
  }

  async getUser(token: string): Promise<UserProfile> {
    const response = await this.client(token).get('/api/user');
    return response.data.user;
  }

  async checkStock(token: string, params: { product?: string; warehouse?: string; thickness_cm?: number }) {
    const response = await this.client(token).post('/api/tools/check-stock', params);
    return response.data;
  }

  async searchPurchaseOrders(token: string, params: { supplier_name?: string; status?: string; delayed_only?: boolean; po_number?: string }) {
    const response = await this.client(token).post('/api/tools/search-purchase-orders', params);
    return response.data;
  }

  async getLandedCost(token: string, poNumber: string) {
    try {
      const response = await this.client(token).post('/api/tools/get-landed-cost', { po_number: poNumber });
      return response.data;
    } catch (err: any) {
      if (err.response && err.response.status === 403) {
        return {
          allowed: false,
          polite_refusal: err.response.data.polite_refusal || 'Cost details are only available to the Purchasing team.',
        };
      }
      throw err;
    }
  }

  async createDraftPO(token: string, payload: { supplier_name: string; items: any[]; estimated_freight?: number }) {
    try {
      const response = await this.client(token).post('/api/tools/create-draft-po', payload);
      return response.data;
    } catch (err: any) {
      if (err.response && err.response.status === 403) {
        return {
          allowed: false,
          polite_refusal: err.response.data.polite_refusal || 'Draft purchase order creation is restricted to the Purchasing team.',
        };
      }
      throw err;
    }
  }

  async confirmDraftPO(token: string, draftToken?: string) {
    try {
      const response = await this.client(token).post('/api/tools/confirm-draft-po', { draft_token: draftToken });
      return response.data;
    } catch (err: any) {
      if (err.response && err.response.status === 403) {
        return {
          allowed: false,
          polite_refusal: err.response.data.polite_refusal || 'Confirming purchase orders is restricted to the Purchasing team.',
        };
      }
      throw err;
    }
  }
}
