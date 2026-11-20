<?php

namespace App\Services;

use App\Models\Product;
use Illuminate\Database\Eloquent\Collection;

class ProductService
{
    /**
     * Search products with flexible keyword and thickness matching.
     */
    public function search(string $query, ?float $thickness = null): Collection
    {
        $words = preg_split('/\s+/', trim($query));

        $builder = Product::query()->with('stocks.warehouse');

        if ($thickness !== null) {
            $builder->where('thickness_cm', $thickness);
        }

        $builder->where(function ($q) use ($words) {
            foreach ($words as $word) {
                if (empty($word)) continue;
                $q->where(function ($sub) use ($word) {
                    $sub->where('name', 'like', "%{$word}%")
                        ->orWhere('sku', 'like', "%{$word}%")
                        ->orWhere('material', 'like', "%{$word}%")
                        ->orWhere('color', 'like', "%{$word}%");
                });
            }
        });

        return $builder->get();
    }

    public function findBySkuOrName(string $identifier, ?float $thickness = null): ?Product
    {
        $product = Product::where('sku', strtoupper(trim($identifier)))->first();
        if ($product) {
            return $product;
        }

        $query = Product::where('name', 'like', '%' . trim($identifier) . '%');
        if ($thickness !== null) {
            $query->where('thickness_cm', $thickness);
        }

        return $query->first();
    }
}

