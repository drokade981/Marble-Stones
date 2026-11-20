<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class CheckStockRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'product' => ['nullable', 'string', 'max:255'],
            'warehouse' => ['nullable', 'string', 'max:255'],
            'thickness_cm' => ['nullable', 'numeric'],
        ];
    }
}

