<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class LandedCostRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'po_number' => ['required', 'string', 'max:50'],
        ];
    }
}

