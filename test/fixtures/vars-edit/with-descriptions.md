---
artifactType: Variables
title: JavaScript Array Domains
description: Real-world collections for the JavaScript Array Utilities snippet — each sub-set names the array, the field to work on, a sample value and the result variable
tags: [javascript, array, utils, collections]
---

## Users
Active users keyed by `status`; works for filter, find, map, group and dedupe.

```vks
VK-array=users
VK-result=activeUsers
VK-property=status
VK-value="active"
```

## Products
A product catalogue grouped or filtered by `category`.

```vks
VK-array=products
VK-result=stationery
VK-property=category
VK-value="stationery"
```

## Orders
Orders summed or sorted by their numeric `total`.

```vks
VK-array=orders
VK-result=revenue
VK-property=total
VK-value=100
```

## Tasks
A to-do list filtered by `priority`.

```vks
VK-array=tasks
VK-result=urgentTasks
VK-property=priority
VK-value="high"
```

## API page
Chunk an API response into pages of 25.

```vks
VK-array=response.data
VK-result=pages
VK-size=25
```

## Tags
A flat array of strings — for Deduplicate primitives and Flatten one level.

```vks
VK-array=tags
VK-result=uniqueTags
```
